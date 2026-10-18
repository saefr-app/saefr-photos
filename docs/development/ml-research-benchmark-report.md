# ML research and benchmark module — completion report

- Status: ready for review; harness implemented, model selection remains open.
- Branch: `codex/ml-research-benchmarks`, based on `integration` at `68d6a1a`.
- Date: 18 October 2026, Asia/Calcutta.
- Implemented commit: none; local reviewable files only.

## Goal and acceptance

Implement the first independent Poorva research module defined in
[the specification](ml-research-benchmark-spec.md). Delivered use-case priorities,
a sourced license/model shortlist, a CPU benchmark protocol, offline CLIP/SigLIP
adapters, deterministic synthetic fixtures and focused benchmark tests.

All harness acceptance criteria are met, including a real pretrained CLIP smoke
run. No production model is selected. SigLIP's adapter is implemented but has not
been exercised with weights; MobileCLIP remains a research candidate without an
adapter. This does not complete representative comparative model evaluation.

## Changed files

| Path | Change and reason |
| --- | --- |
| `research/ml/benchmark.py` | Independent offline CPU CLI, manifest checks, timing/RSS/provenance, ranking metrics |
| `research/ml/make_fixture.py` | Generate deterministic geometric PPMs with annotations, no external images |
| `research/ml/test_benchmark.py` | Known ranking examples, invalid inputs, integrity and output-preservation tests |
| `research/ml/requirements.txt`, `.gitignore` | Record tested dependency versions; exclude local data, weights and generated results |
| `research/ml/*.md` | Usage, priorities, model/license shortlist and benchmark protocol |
| `docs/development/ml-research-benchmark-*` | Scope, this report and sanitized JSON evidence |

## Technical decisions

This is isolated from the active API and avoids choosing storage or inference
contracts prematurely. CLIP/SigLIP use their own paired image/text encoders,
local files only and CPU float32. PyTorch state-dict loading restricts pickle
handling with `weights_only=True`; safetensors is preferred when available.
No model code from Immich was copied. No weights are committed.

The original checkout is on `dev` and contains the user's unfinished changes.
An attached separate worktree from `origin/integration` preserves that checkout.
The fetched integration baseline is the documented team architecture, rather
than silently building on the alternative `dev` backend.

## Verification results

Environment: Windows 11, Python 3.13.7, PyTorch 2.9.1+cpu, Transformers 4.57.1,
Pillow 12.2.0, psutil 7.2.1, safetensors 0.6.2. No database or Docker used.

| Command | Outcome | Evidence / scope |
| --- | --- | --- |
| `python -m unittest discover -v` | PASS, 6 tests | Numeric ranking examples; tampering/path/provenance/relevance validation; existing output preserved |
| `python benchmark.py --help` | PASS | CLI imports without loading a model |
| `python make_fixture.py fixtures/synthetic-v1` | PASS | Six generated images and six annotated queries |
| `python benchmark.py --manifest fixtures/synthetic-v1/manifest.json --model-dir models/clip-vit-base-patch32 --family clip --output results/clip-b32-synthetic-01.json --threads 2 --runs 10 --warmup 2 --k 1` | PASS | Real pretrained CLIP inference; no inference network access |
| Nest build/unit/E2E/lint/integration tests | NOT RUN | No Nest code, dependencies, schema or public API changes |

An initial sandboxed unit-test attempt failed because Windows denied access to
Python's temporary test directory. The same tests passed with the filesystem
restriction lifted; no test assertion was removed. Model preparation downloaded
public artifacts; the benchmark itself used offline local-file loading.

## Recorded CLIP smoke measurements

Model: `openai/clip-vit-base-patch32`, upstream revision
`3d74acf9a28c67741b2f4f2ea7635f0aaf6f0268`. Single process, 2 PyTorch CPU
threads, float32, six synthetic shapes + six queries, 2 extra warmups, 10 runs.

| Measurement | Observed |
| --- | --- |
| Imports + model/processor loading | 13.979 seconds |
| First batch after loading | 1.098 seconds |
| Warm batch median / p95 | 1.039 / 1.121 seconds |
| Images/second, including text encoding and decode | 5.923 |
| Peak sampled process RSS | 982,544,384 bytes (about 937 MiB) |
| Logical snapshot size | 608,863,580 bytes |
| Synthetic precision@1 / recall@1 | 0.833 / 0.833 |
| Synthetic MRR | 0.917 |

Exact metrics, package versions, dataset checksum and model artifact hashes are
in [the JSON evidence](ml-research-benchmark-results.json). The saved slow image
processor was used, as reported by Transformers. This is a single smoke run,
not a statistically representative throughput claim or a model recommendation.

## Security and data safety

No real photos, .env, database, volumes, migrations or backend files were read or
modified by the benchmark. Dataset input is explicitly supplied. The CLI requires
provenance/checksums, bounds batch/image sizes, rejects dataset path escapes,
and refuses to overwrite output. Reports omit raw photos, query text and
embeddings. Generated fixtures/results/models remain ignored. This research CLI
is not a hardened public service and imposes no hard process memory quota.

## Remaining work

- Compare shortlisted models on a licensed representative photo corpus, with
  held-out queries and at least three independent process runs per configuration.
- Measure a named target laptop/mini-PC and agree practical CPU/RAM budgets.
- Exercise SigLIP weights and decide whether a MobileCLIP adapter is worthwhile.
- Finish exact weight-license/notices review before packaging any selected model.
- Propose inference and lifecycle contracts in a separate reviewed module.

## Reproduction

From `research/ml`, use README commands and the recorded requirements. Stage the
model revision above separately, including `pytorch_model.bin`, processor files,
tokenizer files and configuration. The local prepared model and synthetic
fixture are retained as ignored artifacts for another offline run. Use a new
result filename. No real database setup is required.

## Review gate

- [ ] Maintainer reviewed diff.
- [x] Focused automated checks passed.
- [x] Documentation and actual smoke evidence recorded.
- [ ] Commit/push reviewed for this concrete diff.
- [x] Next module not started; no merge, deployment or production integration.
