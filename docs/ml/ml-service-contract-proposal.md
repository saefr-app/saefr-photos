# Worker-to-ML inference contract — proposal v1

Status: **DRAFT, NOT AN ACCEPTED API OR RUNNING SERVICE**. Owner: Poorva's ML
workstream. Reviewers: backend/worker maintainer and affected client developers.
Date: 18 October 2026, Asia/Calcutta.

## Purpose and current compatibility

Define a narrow local image/text embedding boundary without changing the
canonical backend. The shared `integration` backend has no worker, ownership,
scope IDs, content hashes or lifecycle generation yet. Every such field below is
a proposed integration requirement, not a claim about existing asset records.
The separate `dev` `/analyze` stub is also not this contract. Do not rename or
replace it as part of adopting these draft artifacts.

This proposal includes only image and text embeddings. Tags, faces, OCR, batching,
video and public semantic-search endpoints are outside v1. No model is selected.

## Ownership and trust

- Backend owns user sessions, asset authorization, eligibility, canonical bytes,
  lifecycle generations, job persistence and authorized search.
- Worker rechecks eligibility before reading bytes and sends the authorized
  image to the ML service. The ML process receives no database credentials or
  unrestricted photo-library mount and never mutates canonical assets.
- ML accepts only authenticated internal callers. A private network alone is
  insufficient. Credential provisioning/rotation and bearer token versus mTLS
  remain a deployment decision before the service candidate is integrated.
- User tokens are never forwarded. Scope metadata is correlation, not proof of
  authorization; the trusted caller must have checked it. Search results must
  always be filtered using current backend authorization.

## Proposed HTTP interface

| Operation | Proposed request | Proposed success |
| --- | --- | --- |
| `POST /v1/embeddings/image` | Multipart: `metadata` JSON matching image-request schema; one binary `image` part | HTTP 200, image-result JSON |
| `POST /v1/embeddings/text` | JSON matching text-request schema | HTTP 200, text-result JSON |
| `GET /health/live` | Service liveness probe | 200 while process responds |
| `GET /health/ready` | Authenticated readiness probe | 200 only when configured model is locally available and inference slots can be initialized; otherwise 503 |

Multipart fields must not repeat; reject unexpected parts. Limit metadata to
16 KiB, text JSON to 16 KiB and image part to 20 MiB while streaming, before
buffering or decoding. Bound multipart envelope separately to image limit plus
64 KiB. A service implementation must also apply ingress limits before parsing.
Neither a shared filesystem path nor a URL is an accepted input. This avoids
turning inference into an arbitrary-file reader or network fetcher.

Image bytes must match declared size and SHA-256. Decode and detect actual type
independently of the supplied MIME; accept only single-frame JPEG/PNG/WebP and
at most 40 million pixels. Reject malformed/mismatched/multi-frame media. Apply
EXIF orientation, RGB conversion and the exact registered preprocessing. No
claim is made that metadata validation alone verifies image content.

For text, accept 1..1024 characters with non-whitespace content. A concrete model
adapter must reject input exceeding its tokenizer limit rather than silently
truncating it. Tokenizer/configuration identity belongs to the model registry.
The first benchmark harness's truncation behavior is research-only and must not
be copied into the future service without resolving this contract difference.

## Model identity and output

Every request pins `model_id`, immutable `revision`, `artifact_digest`,
`preprocessing_digest` and `dimensions`. These must exactly match an allowlisted
local registry entry. Never interpret a caller's model ID as a path, download
target, remote-code loader or automatic model installation request.

The artifact digest identifies a deterministic manifest of model, processor,
tokenizer and configuration file hashes. Proposed manifest encoding: an object
mapping relative ASCII POSIX filenames to lowercase SHA-256 strings, keys sorted
lexicographically, compact JSON without whitespace, UTF-8, SHA-256 over its
bytes. Exclude download/cache metadata. Preprocessing digest identifies a
similarly canonical manifest of image transforms, text tokenizer/configuration,
normalization and implementation version. The exact registry packaging format
still needs a backend/ML decision; fixtures contain invented identifiers only.

Return an L2-normalized float vector, 1..4096 finite elements, actual length equal
to the registered dimension; norm tolerance is 1e-4. Reject zero/NaN/infinite
vectors. Response echoes request correlation, exact model identity and image
subject/content digest or text scope. No confidence, tags or faces are implied.

Image and query vectors must use the same registered paired encoder and
preprocessing identity. Do not mix generations of model vectors in one search.
Registry dimensions beyond 4096 require a deliberate version/limit review.

## Repeat-safe jobs and retries

`request_id` is a fresh UUID for each HTTP attempt. Logical job identity excludes
that attempt ID. `image_job_key` hashes compact, recursively key-sorted JSON of
all image-request fields except `request_id`, with prefix `ml-v1-`. The v1
image-request identity contains ASCII strings and JavaScript-safe integers only,
so Python and Node producers can reproduce the same bytes. Never place paths,
image bytes, raw queries or secrets in a queue job ID.

Generation, scope, content digest, model and preprocessing identity participate
in that key. Same job/another attempt preserves it; changing any target changes
it. The service is stateless and does not provide durable deduplication. BullMQ
job retention alone is insufficient: the backend needs a unique derived-record
key and transactional upsert/compare-and-set. Repeated inference may vary by
floating-point rounding; idempotence means one accepted target result, not a
promise of bit-identical vectors on every host.

| Error code | HTTP | Worker action |
| --- | --- | --- |
| `INVALID_REQUEST`, `INVALID_IMAGE` | 422 | Permanent; record sanitized code |
| `UNSUPPORTED_MEDIA` | 415 | Permanent |
| `PAYLOAD_TOO_LARGE` | 413 | Permanent |
| `MODEL_MISMATCH` | 409 | Permanent for this target; operator corrects configuration |
| `MODEL_UNAVAILABLE` | 503 | Bounded retry, then operator-visible failure |
| `BUSY` | 429 | Back off; honor bounded retry hint |
| `TIMEOUT` | 504 | Bounded retry; prior computation may still finish |
| `INTERNAL` | 500 | Bounded retry; never expose raw exception text |

Authentication failures return 401/403 and must not be retried without credential
repair. Invalid response bodies or mismatched context must never be persisted;
mark a protocol failure for operator inspection. Network failures and upstream
502/503/504 may be retried within the same budget. Proposed starting policy:
three total attempts with exponential backoff and jitter, bounded to 60 seconds;
30-second per-attempt deadline. These are tunable proposals, not implemented
queue settings. The 14-second model load observed in the first synthetic smoke
run makes readiness/model-loading behavior relevant to timeout testing.

Error JSON contains only schema version, safe request UUID, allowlisted error
code and nullable `retry_after_ms` (100..60,000). It contains no free-form error
details. If the request ID was missing/invalid, generate a fresh safe UUID rather
than reflecting arbitrary input. Auth/ingress failures before the application
may lack this envelope; callers must handle the HTTP status independently.

## Lifecycle and race handling

`subject = {asset_id, scope_id, generation}` is a proposed backend snapshot.
`scope_id` is an opaque authorization boundary, not a mandate to add a Library
table. `generation` is a persisted monotonically increasing safe integer for
that asset; increment on content/eligibility/scope changes, trash, deletion,
disable and restore. Do not reuse deleted asset IDs or reset generation on
restore. Current ACL checks remain mandatory even when generation is unchanged.

1. Enqueue only after durable media publication and metadata acknowledgment.
2. Worker reloads current state/eligibility before reading bytes.
3. Service performs bounded inference and returns the matching context.
4. Before publication, backend atomically compares current asset existence,
   generation, scope, content digest, eligibility and desired indexing model.
   Validate response/request binding and model/vector properties as well.
5. The compare and derived-row write must share a transaction/lock or an
   equivalent atomic conditional write. A check followed by an unlocked insert
   can recreate derived data after deletion. `can_persist_image` illustrates
   comparisons only; it does not implement that transaction.
6. A stale/deleted/ineligible target is skipped, not retried as a processing
   failure. Cancellation of computation is best effort; stale results are still
   rejected if cancellation arrives late.

The invalidation-event fixture carries a new generation and allowlisted reason.
Persist the generation and outbox notification with the lifecycle mutation.
Consumers retain the maximum observed generation; ignore duplicate/older events
and reconcile missed events. Delete vector/index entries from older generations,
preserving newer accepted entries. Events are not the sole access-control gate.
The outbox and reconciliation worker are future backend work, not implemented
by the fixture or pure Python helper.

## Model upgrades and operational bounds

Maintain desired indexing identity separately from active search identity. An
upgrade creates a new target/index namespace; reprocess eligible images without
overwriting vectors still needed by active queries. Switch image/query identity
together once coverage/quality is reviewed; retain bounded rollback data per
policy and delete obsolete versions deliberately. Never compare text vectors
from the new model against the old image vectors.

Proposed first candidate: one model, one active inference slot, CPU baseline,
no hidden unbounded in-service queue; return BUSY at capacity. Process memory,
thread count and container limits must come from measured targets. No runtime
model downloads or external inference calls; installation prepares verified
weights separately. Connection cancellation, timeout, corrupt image, cold model,
process restart and saturation need service-level tests in the next module.

## Decisions needed before integration

Backend/ML reviewers must agree on scope/generation persistence, the actual model
registry and artifact format, internal authentication/transport, durable job and
derived-record keys, vector storage and resource budgets. The draft wire schema
is version 1 for discussion; incompatible accepted changes need a new version.
No migration, endpoint or shared contract has been silently changed here.

## Artifacts and references

- [Executable models and fixtures](../../contracts/ml/v1/README.md)
- [Data/privacy requirements](ml-data-and-privacy-requirements.md)
- [Accepted architectural direction](../decisions/0002-background-processing-and-ml.md)
- [Immich ML architecture reference](https://github.com/immich-app/immich/blob/main/machine-learning/immich_ml/main.py)
- [Pydantic strict validation](https://docs.pydantic.dev/latest/concepts/strict_mode/)

The design and code here are independently written. Referencing Immich does not
approve its specific model choices or persistence schema for Saefr.
