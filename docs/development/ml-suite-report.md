# Core ML implementation and verification — 2026-10-18

All remaining core ML modules in this batch are implemented as a local review
candidate: semantic search, similar-photo retrieval, duplicate suggestions,
durable background indexing, retry/status controls, lifecycle cleanup,
enable/disable, staged re-indexing, container packaging and an optional NestJS
upload bridge. Research, schema and Python inference foundations are included.

## Branches

| Module | Local branch | Module commit |
|---|---|---|
| Research / benchmark | `codex/ml-research-benchmarks` | `12cd202` |
| Inference contract | `codex/ml-service-contract` | `6b0b283` |
| Python service | `codex/ml-service-candidate` | `ae88d14` |
| Semantic search | `codex/ml-search` | `6dece3b` |
| Similarity / duplicates | `codex/ml-similarity` | `40e1d34` |
| Jobs / retries | `codex/ml-jobs` | `17efbe4` |
| Lifecycle / re-index | `codex/ml-lifecycle` | `1183f8b` |
| Backend / containers / final verification | `codex/ml-integration` | report-containing commit |

The tested result is combined locally on `codex/ml-suite`. Shared `integration`
and `main` are unchanged; no push or release is claimed. The original `dev`
checkout's unfinished work is preserved. Module branches are reviewable snapshots
at their respective stages, not independent production release branches.

## Implemented behavior

- A separate Node coordinator/worker owns a private SQLite derived index and
  source-copy cache. It does not access canonical PostgreSQL or delete originals.
  Redis/BullMQ delivers work; the SQLite ledger recovers lost queue entries while
  retaining the durable three-attempt budget. Failures expose fixed safe codes.
- Text and image vectors share a canonical model identity. Model fingerprints
  include pinned weights, runtime packages and normalized adapter source.
  Re-indexing preserves the old query namespace until eligible coverage is
  complete, then atomically switches. Stale model/content/generation/epoch/scope
  results cannot publish.
- Scoped capabilities protect search and management separately. Access is
  rechecked after text inference so revocation blocks late results. Exact cosine
  search has an explicit 10,000 tracked-asset limit per scope; cached inputs have
  a configurable quota (1 GiB default) and a 20 MiB per-image limit.
- Similar photos exclude their source. Duplicate candidates require an explicit
  bounded set, use complete-link grouping and never delete anything.
- Trash, permanent delete, restore, scope transfer and ML disable invalidate
  vectors, input references and sensitive job payloads. Filesystem cleanup is
  retried through recognized orphan reconciliation. Missing cache files request
  authorized resupply without resetting unrelated inference failures.
- The opt-in NestJS bridge durably captures new upload IDs after successful
  metadata publication and retries acknowledged handoff across restarts. It is
  disabled by default, restricted to local single-scope operation and requires
  separate opt-in before scanning existing library metadata/bytes.
- Compose provides separate inference/API/worker/Redis processes, dedicated ML
  volumes, read-only model mounts, resource limits and loopback-only API publish.
  Private setup/bootstrap tools avoid printing credentials. The supplied CI
  workflow covers Python, coordinator and Linux backend checks; remote CI has
  not run because nothing has been pushed.

## Observed checks

| Check | Result |
|---|---|
| Coordinator `npm ci` / `npm test`, Node 24.19.0 | 22 passed |
| Python inference `python -m unittest discover -s tests -v` | 17 passed |
| Contract schema tests | 13 passed |
| Research benchmark tests | 6 passed |
| Linux backend Docker test image: build / unit / HTTP / lint / runtime smoke | 66 unit, 38 HTTP; build, lint and startup/shutdown checks passed |
| Backend `npm run test:integration`, isolated PostgreSQL 18 | 35 passed; owned disposable container removed |
| Inference and coordinator Docker builds | passed |
| `docker compose ... -f compose.ml.yml config --quiet` | passed with temporary generated configuration; credentials removed |
| Real CLIP + Redis + BullMQ + coordinator test | passed; evidence linked below |

The real-model smoke used synthetic colored-square PNGs, pinned CLIP
`openai/clip-vit-base-patch32` revision
`3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268`, 512-dimensional vectors, an internal
Docker network and no development volumes. It verified ranking, scope isolation,
duplicate suggestions, two-attempt transient recovery, lost-queue recovery,
worker restart, late-result rejection and disable purge. Independent API/worker
entrypoints shared a new labeled volume, stopped with exit codes 0/0 and retained
disabled state/zero vectors after restart. Inference ran with 2 CPUs/2 GiB;
coordinator with 1 CPU/1 GiB. Owned test resources and temporary credentials were
removed. See [final machine-readable evidence](ml-suite-container-evidence-final.json).

Native Windows backend tests previously encountered four existing POSIX
permission/symlink expectation failures; those tests were preserved and all
passed in the Linux image. HTTP tests use fake database settings; the separate
35-test suite supplies actual disposable PostgreSQL coverage. Synthetic ranking
is a pipeline check, not a semantic quality benchmark for personal libraries.
Sandboxed Python invocations also encountered temporary-directory permissions
and a stalled async test; they were stopped and rerun with the normal local
runtime, where all 17 inference and 6 benchmark tests passed. No assertions were
weakened to accommodate the sandbox.

## Practical limits and next review

The implementation is ready for source review and synthetic local trial using
the [runbook](../ml/ml-suite-runbook.md). ML remains disabled in the real backend;
no personal library, application environment, database migration or public
deployment was exercised.

The backend still needs accounts/ownership and canonical trash/delete APIs;
the coordinator's scoped lifecycle interface is available for their later event
integration. There is a narrow crash window between PostgreSQL commit and bridge
pending-record capture. Approved backfill can reconcile misses; a canonical
transactional outbox requires a separate reviewed migration. Durable guarantees
start at the coordinator's acknowledged ledger. Filesystem purge cannot promise
secure erasure from backups/swap. Python cannot interrupt a hung native inference
thread; process restart remains the recovery boundary.

Product-scale retrieval, model relevance across languages/photo types, minimum
hardware targets, production backups/restores and optional faces/tagging require
their own evaluation. These are not represented as completed product features.
