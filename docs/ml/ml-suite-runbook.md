# Running the completed core ML modules

The combined implementation is on local `codex/ml-suite` after verification;
individual module branches retain their own reviewable commits. Nothing here
publishes a release or upgrades the canonical database. Original `dev` work is
preserved in its original checkout.

## Prepare a standalone local stack

1. Stage a reviewed local CLIP snapshot; the smoke baseline is
   `openai/clip-vit-base-patch32` at
   `3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268`. This is a tested baseline,
   not a final model-quality recommendation. Review licenses before shipping.
2. Build `machine-learning/Dockerfile` from its directory. Prepare its registry
   using that image's `python -m saefr_ml.prepare_model`, read-only `/models`
   and a new writable local configuration-preparation directory. Use no network.
   Runtime/package/adapter changes intentionally require a new registry.
3. Run `tools/setup-ml-config.py --registry <prepared-registry> --model-dir
   <snapshot> --output-dir ml-coordinator/local/config`. It creates new protected
   token/access/model files. An existing output directory is refused. Keep these
   files out of Git and make them readable only by the intended operator/service
   accounts. The registry/model identity files are safe to read by the ML runtime;
   token files are not.
4. From the repository root:

```powershell
docker compose --env-file ml-coordinator/local/config/credentials.env -f compose.ml.yml up -d --build
python tools/bootstrap-ml-scope.py --config-dir ml-coordinator/local/config
```

Compose uses project `saefr-ml`, two new ML-owned volumes, separate API/worker,
Redis AOF and a local inference service. Only the coordinator is published, on
`127.0.0.1:8002`. Model weights/registry are mounted read-only; no photo-library
or PostgreSQL volume is attached. The inference/worker network is internal.
Stop this stack with the same Compose file; preserve its volumes unless you
have deliberately chosen to discard derived data. Do not run volume-removal
commands against the development backend.

## Use the scope credentials

`client-tokens.json` contains distinct operator, scope-manager and search
credentials. Bootstrap uses the operator; image submission and lifecycle use
the manager; search/similarity use the search credential. The manager is scoped
to the generated scope, not all users. Asset UUIDs and strictly increasing
generations are supplied by a trusted backend integration.

See [the coordinator API](../../ml-coordinator/README.md). Submit bytes through
the coordinator, inspect its returned durable job, then query text or photo
similarity. Duplicate results are review suggestions and never trigger deletion.

## Optional NestJS bridge

The existing NestJS API gains an opt-in bridge; defaults remain disabled.
Enable it only for approved new uploads to the local single-scope prototype:

- `ML_ENABLED=true`
- `ML_COORDINATOR_URL=http://127.0.0.1:8002`
- `ML_COORDINATOR_TOKEN=<scope-manager capability>`
- `ML_SCOPE_ID=<configured scope UUID>`
- `ML_BRIDGE_STATE_DIR=<new private pending-state directory outside STORAGE_ROOT>`
- Keep backend `HOST` loopback. Remote coordinator URLs and public backend binds
  are rejected while this prototype bridge is enabled.

After immutable originals and metadata are acknowledged, the bridge captures a
private pending UUID record, then hands the bytes to the coordinator. A 202 with
matching asset/generation is required before removing that pending record.
Failures retain pending work across restart and preserve the successful photo
upload. Disabled scopes are respected; records bound to another scope are not
reused. The bridge does not change existing DTOs, public routes or schema.

Existing-library backfill is **off**. Set `ML_BACKFILL_ENABLED=true` only after
explicitly approving that library for local ML processing. Backfill scans rotate
in bounded batches. No existing personal library was backfilled during this task.

Capture is not an atomic transaction with the canonical PostgreSQL commit: a
crash in the narrow commit-to-capture window can miss a trigger. Approved
backfill reconciles such gaps. A transactional canonical outbox belongs in a
future backend migration; no such migration was silently introduced. Durable
processing guarantees begin once the coordinator acknowledges its own ledger.
The current backend has no owner/session or trash/delete API; the scoped bridge
does not claim to implement those backend milestones. The coordinator already
accepts explicit lifecycle events for later authenticated backend controllers.

## Re-index, disable, delete and restore

- Stage a second compatible service/model route before starting a model upgrade;
  keep the old route for active text queries. Re-index the desired namespace,
  inspect coverage and quality, then activate atomically. Prune old versions
  separately after deciding rollback retention.
- Disable ML through scope settings. Cached input copies, vectors and job request
  payloads are purged, and late results are rejected. Re-enable requires approved
  input resupply; the bridge respects this scope state.
- Trash/delete/move require a new generation. Restore is supported for trash;
  permanent UUID tombstones cannot be reused. Restore/move needs new authorized
  input submission. Older events are ignored.
- Filesystem cleanup can fail; the API surfaces cleanup-pending state and the
  recognized-orphan reconciler retries cleanup. The canonical library is never
  cleaned by the coordinator. Secure erasure/backup retention are host policies.

## Verification

```powershell
# coordinator contracts, persistence, privacy, lifecycle and failure checks
npm --prefix ml-coordinator ci
npm --prefix ml-coordinator test
# complete real-model stack, with labeled disposable resources only
python tools/ml-stack-smoke.py --model-dir <snapshot> --output <new-evidence.json>
# Linux backend regression suite, using fake HTTP DB settings and no network
docker build -f server-nest/Dockerfile.test -t saefr-ml-backend-tests:local server-nest
docker run --rm --network none saefr-ml-backend-tests:local
```

Build the coordinator image with the schema build context (Compose does this):
`docker build --build-context contract_schemas=./contracts/ml/v1/schemas -t
saefr-ml-coordinator:local ml-coordinator`.

Existing PostgreSQL tests use the repository's safety-checked disposable runner.
Never replace its generated configuration with the ordinary `.env`. Python
inference/contract/benchmark checks are also included in the ML CI workflow.
The workflow is supplied as code; no remote CI run is claimed before a push.
