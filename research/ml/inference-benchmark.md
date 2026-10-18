# CPU inference benchmark protocol

## Experiment design

1. Stage a complete local model snapshot and record its repository/revision,
   license artifacts and preparation command. The CLI hashes every snapshot file.
2. Use the generated six-image geometric fixture for a smoke test only.
3. Assemble a separately licensed representative corpus with source/license per
   image. Include objects, scenes, activities, low light, crops, edited copies and
   hard negatives. Annotate relevant image IDs for every query before comparing
   models. Keep selection/tuning queries separate from held-out evaluation.
4. Current CLI processes one batch of at most 64 images and 64 queries. Use a
   fixed corpus within that limit for initial comparisons. Full-library indexing,
   larger corpora, chunking and vector-database performance need later work.
5. Compare the same images, annotations, query wording, thread count and runtime
   environment. Use fresh processes, CPU float32, 2 warmups and at least 10 runs.
   Repeat each configuration in at least 3 processes; record competing workloads.

## Measurements

| JSON field | Meaning |
| --- | --- |
| `load_seconds` | Runtime imports, processor/model load; excludes downloading |
| `first_batch_seconds` | First complete image+text retrieval batch after loading |
| `warm_batch_p50_seconds`, `warm_batch_p95_seconds` | Median and nearest-rank p95 over repeated complete batches |
| `warm_images_per_second_with_text` | Image count / warm duration, including the fixed text batch and decoding |
| `sampled_peak_rss_bytes` | Process RSS maximum observed at 10 ms intervals; may miss brief peaks |
| `snapshot_logical_bytes` | Sum of snapshot file sizes; not allocated disk blocks or installed dependency footprint |
| `precision_at_k` | Relevant hits / effective k, averaged over queries |
| `recall_at_k` | Relevant hits / all annotated relevant images, averaged over queries |
| `mrr` | Mean reciprocal rank of first relevant image over full batch rankings |

Effective k is `min(requested k, corpus size)`. Ties retain manifest image order.
Use k=1 for the small synthetic fixture. With one relevant item, precision@5
cannot exceed 0.2, even when the first result is correct.

Timings include image decode, EXIF orientation correction, preprocessing,
image/text encoders and cosine scoring. They do not measure a production search
API, vector database, or cached text-only query. A cold process is not a cold OS
file cache; do not label load timings as cold-disk measurements. Thread settings
are recorded but do not impose a hard CPU or RAM quota.

## Gates before selecting a model

- Actual weight license, notices and redistribution requirements reviewed.
- Representative relevance results and failure examples reviewed by the team.
- CPU latency/RAM targets agreed for a named laptop or mini-PC, then measured.
- Compare shortlist candidates; do not pick a winner from published GPU/mobile
  latency numbers or geometric fixtures.
- Optional acceleration, quantization, language coverage and memory-constrained
  deployment tested separately before advertising support.

No representative benchmark numbers have been produced by writing this protocol.
Actual commands and results belong in the development report and JSON artifacts.
