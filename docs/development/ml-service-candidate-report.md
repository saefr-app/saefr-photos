# Standalone ML service candidate — completion report

- Status: ready for code review; container execution unverified.
- Branch/base: `codex/ml-service-candidate`, `integration` at `68d6a1a`.
- Date: 18 October 2026, Asia/Calcutta.
- Implemented commit: none; reviewable local changes only.

## Goal and resulting behavior

The new independent `machine-learning/` candidate turns the prior draft wire
contract into real CPU inference. Authenticated callers can submit one image or
text query and receive a versioned 512-dimensional unit embedding from the local
CLIP smoke baseline. No NestJS/backend API, database, worker or search endpoint
is connected. The user's existing `dev` stub and unfinished work are preserved.

See [scope and acceptance](ml-service-candidate-spec.md) and
[runtime/reproduction instructions](../../machine-learning/README.md).

## Changed files

| Path | Change / purpose |
| --- | --- |
| `machine-learning/saefr_ml/app.py` | FastAPI factory, caller credential, health checks, single-slot admission, timeouts and sanitized errors |
| `machine-learning/saefr_ml/ingress.py` | Bounded streamed in-memory multipart/JSON parsing; no temporary upload spooling |
| `machine-learning/saefr_ml/engine.py` | Local registry hashing/verification, CLIP CPU adapter and real image decoding/preprocessing |
| `machine-learning/saefr_ml/prepare_model.py` | Operator-only offline registry preparation from local files |
| `machine-learning/saefr_ml/contract.py` | Unchanged snapshot of the previous draft's strict wire validators |
| `machine-learning/saefr_ml/{errors,__init__,__main__}.py` | Error allowlist support, package and localhost entry point |
| `machine-learning/tests/` | HTTP, decoding, cancellation, timeout and model-registry tests |
| `machine-learning/smoke_real_model.py`, `smoke_process.py` | Reproducible real-model handler/process smoke checks |
| `machine-learning/{Dockerfile,.dockerignore}` | Independent CPU runtime candidate; no model weights/secrets bundled |
| `machine-learning/{README.md,requirements*.txt,.gitignore}` | Setup, boundaries, pinned tested packages and generated-artifact exclusions |
| `docs/development/ml-service-candidate-*` | Spec, report and sanitized smoke evidence |

## Technical decisions

The branch is independently based on integration rather than chained onto an
uncommitted feature branch. A byte-identical snapshot of the reviewed contract
is included for standalone imports. Its SHA-256 is
`19859a45b6419ed85209560e5863d79f4d9db47da367c80bdc5deac08a50be04`;
consolidate the shared package when reviewed branches are integrated.

CLIP is the only candidate adapter. Registry hashes cover weights, tokenizer,
processor and config; preprocessing identity also includes runtime versions.
Caller-specified identity must match it exactly. Loading is local-only, remote
code is disabled, published state dictionaries use restricted weights-only
loading, and models are not installed from requests. Operator authenticity/
license checks and immutable local model/registry ownership are still required.

The candidate uses a provisional internal bearer token with no default, rather
than waiting for shared user authentication. It authenticates the caller only;
backend asset/scope authorization is not implemented. Cross-host TLS/mTLS and
credential provisioning/rotation remain deployment review items.

Admission covers parsing and inference, with one worker thread. Timeout returns
504 while cancellation is shielded from cancelling its underlying future. The
slot is released only on actual completion, including late failure; retries see
429 meanwhile. This prevents a cancelled HTTP request from launching overlapping
unbounded work. A hung native call can still require a process restart; no hard
thread cancellation or process RAM quota is claimed on the host.

## Verification results

Environment: Windows 11, Python 3.13.7, FastAPI 0.116.1, Starlette 0.47.3,
Uvicorn 0.35.0, Pydantic 2.11.7, python-multipart 0.0.20, HTTPX 0.28.1,
PyTorch 2.9.1+cpu, Transformers 4.57.1, Pillow 12.2.0.

| Command/check | Result | Scope |
| --- | --- | --- |
| `python -m unittest discover -s tests -v` | PASS, 17 tests | Fake engine for HTTP/control flow; real Pillow decode; synthetic registry files |
| `python -m saefr_ml.prepare_model ... --output local/registry.json` | PASS | Hash existing local CLIP snapshot; no download |
| `python smoke_real_model.py ...` | PASS | Real image/text inference through HTTP handlers using synthetic PNG |
| `python smoke_process.py ...` | PASS | Independent loopback Uvicorn process, readiness/liveness, real text vector, process stopped, listener closed |
| Vendored contract SHA-256 comparison | PASS | Exact match to the prior module |
| `docker info --format '{{.ServerVersion}}'` | UNAVAILABLE | Docker CLI exists, but `dockerDesktopLinuxEngine` named pipe does not; daemon is stopped |
| Docker build / resource-limited run | NOT RUN | Cannot execute against unavailable daemon |
| Nest build/unit/E2E/lint/PostgreSQL tests | NOT RUN | No backend/dependency/schema changes |

The first sandboxed TestClient test did not progress; it was interrupted and the
suite passed outside the Windows sandbox. No test assertions were removed to
obtain a pass. Real-model verification is separate from the fake-engine suite.

## Actual smoke evidence

Model: `openai/clip-vit-base-patch32`, revision
`3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268`, CPU float32, 2 threads.

- Readiness after model load: 6.072 seconds in the recorded process environment.
- One synthetic image request: 0.162 seconds; one text request: 0.044 seconds.
- Both outputs: 512 finite dimensions, L2 norms approximately 1.0.
- A 202-token query was rejected with 422 rather than truncated to CLIP's 77-token context.
- Independent loopback process served a real 512-dimensional text embedding.
  Its test process was terminated and listener closure checked. Windows process
  termination does not prove graceful signal handling; evidence says so explicitly.

See [handler smoke JSON](ml-service-candidate-real-smoke.json) and
[process smoke JSON](ml-service-candidate-process-smoke.json). These are single
smoke timings, not representative photo quality or comparative model benchmarks.
They contain no vectors, credentials, queries or source media.

## Safety and remaining limitations

No development DB, Docker volume, source photo library, root Compose file,
existing backend or user `.env` was used or modified. The smoke process used its
own ephemeral localhost port and was stopped; no service remains running.
Generated model config and local evidence are ignored, while sanitized copies
are included in the report artifacts.

Docker build/run is still required when the daemon is available. Re-prepare the
registry inside the container's exact runtime before testing; preprocessing
identity intentionally detects package differences. The proposed 2-CPU/2-GiB
container budget, read-only mounts, offline networking and shutdown deadline
have not been exercised here.

Backend authorization, persistent jobs, transactional result acceptance,
deletion/re-index orchestration and vector search remain separate integration
work. Production model selection still requires licensed representative photos,
held-out queries, hardware benchmarks and license review. This candidate handles
one paired CLIP model and does not implement SigLIP/MobileCLIP, faces or tagging.

## Review gate

- [ ] Maintainer reviews the concrete diff and candidate boundaries.
- [x] Focused tests and real local inference checks passed.
- [x] Unavailable container/backend checks clearly recorded.
- [ ] Container build/resource-limit checks completed.
- [ ] Commit/push reviewed for this diff.
- [x] No merge, deployment or next milestone started.
