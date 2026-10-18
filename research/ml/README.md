# Poorva's ML research and CPU benchmark

Status: independent research prototype, not a model selection or backend integration.
Based on `integration` at `68d6a1a`. The existing `dev` checkout has a different
backend and unfinished work; this module does not depend on or modify it.

## Scope

Read [priorities](ml-use-cases-and-priorities.md), the
[model/license matrix](model-license-matrix.md), and the
[benchmark protocol](inference-benchmark.md). No shared API, database schema,
queue, deployment, or production ML service changes are included.

## Run locally

From `research/ml`, use a dedicated Python environment. The runtime tested on
this machine is recorded in the milestone report. For another environment,
install PyTorch CPU and Transformers using their official installation guides,
plus Pillow, psutil and safetensors. Record exact installed versions with each
result; package installation is separate from the offline benchmark.

```powershell
python -m unittest discover -v
python make_fixture.py fixtures/synthetic-v1
python benchmark.py --manifest fixtures/synthetic-v1/manifest.json --model-dir models/clip-snapshot --family clip --output results/clip-run-01.json --threads 2 --runs 10 --warmup 2 --k 1
```

`--model-dir` must point to a complete local Hugging Face snapshot with
safetensors weights (preferred) or published PyTorch weights and processor/tokenizer files.
PyTorch weights use the restricted `weights_only=True` loader; use PyTorch 2.6 or newer.
Stage that snapshot separately
and record its upstream repository and revision in your experiment notes. No
remote code or model IDs are loaded by this CLI. SigLIP uses `--family siglip`.
MobileCLIP has no adapter yet. Existing result files and fixture directories
are never overwritten. Run fresh processes for model comparisons.

The manifest format is illustrated by the fixture generator: each image has an
ID, relative file path, SHA-256, license and source; each text query has a
nonempty list of relevant image IDs. Generated data/results/models are ignored.
Do not commit personal photos or queries. Reports contain aggregate metrics and
file hashes, not raw images, text queries, or embeddings.

Only the benchmark process is measured. RSS is sampled every 10 ms, including
runtime imports/model loading, so it is an approximate process memory maximum.
The CLI enforces CPU float32 and a configurable PyTorch thread count. It is a
trusted local research tool, not a hardened service for untrusted requests.

## Interpretation

Synthetic shapes validate execution and metric plumbing only. A high synthetic
score does not demonstrate real-world semantic search. A selected model still
needs a licensed photo corpus, relevance annotations and realistic hardware
measurements. See the protocol for acceptance gates and missing evidence.
