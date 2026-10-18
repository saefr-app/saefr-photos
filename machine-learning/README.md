# Standalone ML service candidate

Experimental implementation of the reviewed v1 draft for **image and text
embeddings**. Runs independently of NestJS, PostgreSQL and Redis. It is not
integrated with Saefr's public API and is not a production model-selection decision.
The existing `dev` ML stub remains untouched.

## Implemented

- Authenticated `POST /v1/embeddings/image` (multipart metadata + image bytes),
  `POST /v1/embeddings/text` (JSON) and `GET /health/ready`.
- Public `GET /health/live`; interactive docs disabled.
- One local pinned CLIP model, CPU float32, two PyTorch threads by default.
- Registry verifies all supported snapshot files and runtime preprocessing
  versions; requests must match its exact revision, digests and dimensions.
- One admitted request across parsing/inference, no inference queue. BUSY=429.
- Bounded streamed in-memory parsing: 20 MiB image, 16 KiB metadata/text,
  64 KiB multipart overhead. No upload files are spooled to disk.
- JPEG/PNG/WebP detection, single-frame/40-million-pixel limits, SHA-256 and
  byte-count integrity, EXIF orientation and RGB preprocessing.
- Finite unit-normalized vectors. Over-context queries rejected, not truncated.
- Sanitized error codes. Timed-out/cancelled inference retains admission until
  its actual thread finishes. Body timeout is 15 seconds, inference timeout 30.

The bearer credential authenticates the internal caller only. Scope/generation
metadata is not authorization. Backend eligibility, query authorization, durable
jobs and transactional stale-result rejection remain integration responsibilities.
No storage mount, database credentials or inference network access is required.

## Prepare and run locally (PowerShell)

Use Python 3.13 in a dedicated environment. Install PyTorch from the official CPU
wheel index and then this directory's pinned requirements. Model downloads are
a separate, deliberate preparation step; service requests never install models.
The CLIP baseline used for smoke verification is `openai/clip-vit-base-patch32`
at revision `3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268`.

```powershell
$env:ML_MODEL_DIR = 'C:/path/to/local/clip-snapshot'
python -m saefr_ml.prepare_model --model-dir $env:ML_MODEL_DIR --model-id openai/clip-vit-base-patch32 --revision 3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268 --output local/registry.json
$env:ML_REGISTRY_PATH = (Resolve-Path local/registry.json).Path
$env:ML_SERVICE_TOKEN = python -c "import secrets; print(secrets.token_urlsafe(32))"
python -m saefr_ml
```

The CLI binds to **127.0.0.1:8001**, one process, connection concurrency capped
at eight. Do not add workers without separately budgeting model memory. Provision
and rotate the bearer token outside Git; 32..256 ASCII URL-safe characters are
required and there is no default token. Use HTTPS or reviewed mTLS when crossing
hosts; bearer authentication by itself does not encrypt transport.

`prepare_model` hashes a flat complete snapshot: configuration, tokenizer,
processor and `.bin`/`.safetensors` weights. It excludes `.cache`, rejects paths
outside the snapshot/remote Python files and refuses to overwrite a registry.
The operator must verify the upstream revision and licenses independently;
hashing arbitrary local files does not establish publisher authenticity. Keep
registry/model files operator-owned and immutable while serving. Runtime package
changes require re-preparing and reviewing preprocessing identity. Safetensors
is preferred; published PyTorch state dictionaries use `weights_only=True` on
PyTorch 2.9.1. Never provision arbitrary uploaded model files.

Image requests require the draft contract's metadata and exactly one `image`
part. Use the operator registry's `model` object in both image and text requests.
Its invented scope/asset/generation examples do not grant access to any asset.
`smoke_real_model.py` is a reproducible example that generates its own image and
checks responses without printing vectors or credentials.

## Verify

```powershell
python -m pip install -r requirements-dev.txt
python -m unittest discover -s tests -v
python smoke_real_model.py --model-dir $env:ML_MODEL_DIR --registry local/registry.json --output local/real-smoke.json
python smoke_process.py --model-dir $env:ML_MODEL_DIR --registry local/registry.json --output local/process-smoke.json
```

Focused HTTP tests use a fake inference engine and real Pillow decoding;
cancellation/timeout and registry-tampering tests require no pretrained model.
Real-model smoke scripts separately load local CLIP. Process smoke uses a fresh
loopback port and always stops its own child; Windows process termination does
not prove graceful SIGTERM behavior. Generated artifacts and model weights are
ignored. No tests use the development database or private media library.

## Container candidate

`Dockerfile` has been built and exercised with real offline CLIP inference on
synthetic fixtures; see the [combined verification report](../docs/development/ml-suite-report.md).
The runtime image uses CPU PyTorch, UID 10001 and
does not bundle weights or credentials. Build with:

```powershell
docker build -t saefr-ml-candidate:local .
```

Prepare the registry using the same image/runtime versions before mounting it
read-only at `/config/registry.json`; mount the model snapshot read-only at
`/models`, supply `ML_SERVICE_TOKEN`, and run a single worker. For a local proof,
limit the container to 2 CPUs and 2 GiB RAM, read-only root filesystem and a
small bounded `/tmp`; publish only `127.0.0.1:8001:8001` on a dedicated test
network with no external egress. These limits passed the recorded synthetic
container flow; they are not a production capacity guarantee. Do not attach the real storage library, application environment or
development database network/volumes.

## Limits and review boundary

This inference service does not select a production model or persist embeddings.
The separate `ml-coordinator/` supplies scoped capabilities, persistence, search,
queue processing, lifecycle cleanup and re-index orchestration. Concurrency is bounded, but Python
threads cannot force-stop a hung native inference call: the request times out,
capacity remains occupied, and process restart may be required. Graceful shutdown
waits for in-flight work; orchestrators need their own shutdown deadline.
Process/container memory quotas and swap/core-dump retention are deployment
concerns, not guarantees supplied by in-memory body parsing.

The service includes an unchanged snapshot of the prior proposal's `contract.py`
inside `saefr_ml` so this branch can run independently of another uncommitted
branch. Consolidate that shared contract package when reviewed branches are
integrated. Request schemas are unchanged; CLIP is the only candidate adapter
implemented here. Backend contract and security review still precede integration.
