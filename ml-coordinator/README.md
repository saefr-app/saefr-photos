# Saefr ML coordinator

The remaining core ML modules run together here: scope-authorized semantic
search, similar photos, exact/near-duplicate suggestions, BullMQ processing,
versioned embeddings/re-indexing, and deletion/ML-disable controls. Python
`machine-learning/` supplies local inference; this Node process owns derived
state and orchestration. No canonical PostgreSQL schema is changed.

## Components and limits

- Node 24 recommended; Node 22.13+ uses `--experimental-sqlite`.
- A separate API and single-concurrency BullMQ worker share one **owned local
  SQLite index and source cache**. Use a local filesystem with SQLite locking,
  not an unverified NAS/multi-host volume.
- Exact cosine search, capped at 10,000 tracked asset IDs per scope by default.
  `ML_MAX_ASSETS` configures the cap. It is not a large-library ANN index.
- `ML_CACHE_MAX_BYTES` defaults to 1 GiB across managed source copies. Capacity
  exhaustion rejects new work without modifying canonical originals.
- Managed source copies support model re-indexing. They are private user data;
  ML disable/trash/delete/move purges them, embeddings and sensitive job payloads.
  Re-enable/restore/move needs authorized source resupply.
- Scope-scoped credentials are capabilities for trusted integrations, not an
  implemented mobile user-login/session system. Configure one search token per
  permitted scope or set of scopes. Management and operator credentials are
  separate. No wildcard scope grants are accepted.

## Configuration

Required: `ML_STATE_DIR`, `ML_ACCESS_FILE`, `ML_MODELS_FILE`, `ML_REDIS_HOST`,
`ML_REDIS_PORT`, `ML_QUEUE_NAME` (starts `saefr-ml-`). Optional API bind defaults
to `127.0.0.1:8002`; `ML_API_HOST`/`ML_API_PORT` customize it. Model routes are
operator-owned configuration, never request URLs:

```json
{"models":[{"model":{"model_id":"example/paired","revision":"PINNED_REVISION","artifact_digest":"SHA256","preprocessing_digest":"SHA256","dimensions":512},"url":"http://inference:8001","token_env":"ML_INFERENCE_TOKEN"}]}
```

The illustrative identity above is not a valid request. Copy the exact `model`
object from the prepared runtime registry. Route credentials come from the
named `ML_*` environment variable, never from committed JSON.

Access configuration stores SHA-256 hashes of randomly generated URL-safe bearer
tokens, an operator hash and explicit principal scopes/permissions. It is reread
at authorization boundaries, including after asynchronous query inference, so
revocation takes effect without a process restart. `tools/setup-ml-config.py`
creates new private files, random credentials and one scope without printing
tokens. Root/operator is used only for initial scope creation; the backend
bridge uses the scope-limited manager credential.

## API

All `/v1` operations need a bearer credential. Unauthorized scope access returns
404. Responses contain asset IDs/similarity scores and model identity, not raw
vectors or private paths.

| Method/path under `/v1/scopes/:scopeId` | Permission | Behavior |
| --- | --- | --- |
| `PUT /` | operator | Create scope with allowlisted `model_key` |
| `GET /status` | manage | Coverage, current/desired models and job counts |
| `PUT /assets/:assetId` | manage | Stream JPEG/PNG/WebP bytes, `X-Asset-Generation` required; returns durable job with 202 |
| `GET /assets/:assetId` | manage | State, generation, indexing and input-resupply status |
| `POST /search` | search | `{text, limit?, min_score?}`; authorized cosine top-k |
| `GET /assets/:assetId/similar` | search | Nearest other photos; optional `limit`/`min_score` |
| `POST /duplicates` | search | `{asset_ids, min_score?}`; conservative suggestions, 2..256 unique IDs |
| `POST /assets/:assetId/lifecycle` | manage | `{generation,state}` where state is `trashed`, `deleted` or restored `eligible` |
| `POST /assets/:assetId/move` | manage both scopes | New generation + destination scope; purge old derivatives/input |
| `PATCH /settings` | manage | `{enabled:false}` purges derived data; true requires source resupply |
| `POST /reindex` | manage | `{model_key,force?}`; queue new namespace and retain active search |
| `POST /reindex/activate` | manage | Switch only when every eligible asset has the desired embedding |
| `POST /models/prune` | manage | Remove model versions other than active/desired |
| `GET /jobs` or `/jobs/:jobId` | manage | Sanitized durable job state/attempt/error visibility |
| `POST /jobs/:jobId/retry` | manage | Explicit failed-job retry with an idempotent UUID `retry_id` |

`GET /health/live` is public; `/health/ready` requires operator authorization and
checks Redis availability. JSON bodies are bounded to 16 KiB, image bodies to
20 MiB, with a 15-second ingestion deadline. Inference has a 30-second deadline.
One source mutation is admitted at a time and at most four pending search calls
are allowed. Credentials, source names and queries are not placed in queue IDs
or logged. Production transport across hosts needs reviewed TLS/mTLS.

## Correctness and recovery

The index validates scope, asset generation, content hash, desired model and
scope epoch **inside** the result-publication transaction. A deleted/disabled or
changed target cannot be recreated by a late result. Tombstones are monotonic;
older lifecycle events are ignored, and permanent deletion forbids UUID reuse.
An expiring UUID-based API lease fences mutations and prevents two API writers
even if container PIDs are reused. Worker publication does not depend on API PID.

The durable ledger is authoritative; Redis is scheduling state. Reconciliation
recreates missing queue entries without granting fresh retry budgets. Transient
failures get up to three attempts with bounded jittered backoff; permanent
failures stop immediately. An explicit operator retry creates a distinct bounded
run. Exact bytes can reuse inference only within the same scope/model. Raw inputs
are not shared across users/scopes. Missing/corrupt cache requests source resupply;
the original library is never searched, deleted or repaired by this coordinator.

Model upgrades require both old/new model routes while old search stays active.
Stage the new local inference service, restart API/worker with the new route,
request re-indexing, inspect coverage/quality, then activate. Old vectors remain
until explicitly pruned. Existing and new image/query vectors are never mixed.

Duplicate grouping is a suggestion, not a deletion decision. Complete-link
groups require every pair to pass the threshold, avoiding transitive chains.

## Run and test

```powershell
npm ci
npm test
npm start
# In a separate terminal with the same protected configuration:
npm run worker
```

From the repository root, `compose.ml.yml` defines the standalone private ML
stack and its own volumes; it never mounts the canonical library or database.
Prepare weights/registry before starting. Use the runtime's exact packages when
preparing the registry. The root instructions in `docs/ml/ml-suite-runbook.md`
show preparation, credentials, optional backend integration and verification.

`npm run test:integration` requires an explicit isolated `ML_TEST_REDIS_PORT`.
Its default inference adapter is synthetic; it touches only a random queue
namespace and disposable index. The root `tools/ml-stack-smoke.py` runs actual
CLIP + Redis + Node containers, including independent API/worker entrypoints,
using generated PNGs. It verifies labels before deleting only its own resources.

## Retention and backups

Logical purge is not forensic secure erasure of filesystem blocks, SQLite
journals, OS swap or backups. Protect state/cache directories and backups; use
encryption and explicit backup retention as appropriate for the host. Stop API
and worker before copying the owned state volume (or use a tested consistent
SQLite snapshot procedure); an arbitrary copy of only the `.sqlite` file can
miss WAL transactions. Restore indexes in quarantine and reconcile against
current authoritative lifecycle/permissions before exposing search. Rebuilding
derived indexes from approved originals is safer than resurrecting stale data.

This is a bounded initial implementation. Full mobile authentication, canonical
trash/delete APIs, representative model evaluation, face grouping, tagging,
video and approximate indexing are outside these core ML modules.
