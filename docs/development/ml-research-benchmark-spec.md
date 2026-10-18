# ML research and benchmark module — specification

- Owner: Poorva's ML workstream.
- Scope authorized in chat: first research module and standalone CPU benchmark.
- Base: `integration` at `68d6a1a`; branch `codex/ml-research-benchmarks`.
- Date: 18 October 2026, Asia/Calcutta.

## Deliverable

An independent `research/ml/` directory with use-case priorities, model/license
shortlist, offline CPU benchmark CLI and reproducible synthetic fixtures. Use
Immich as an architectural reference, with independently written implementation.

## Acceptance

- [ ] No backend, database, media library, queue or shared API changes.
- [ ] Local-only model loading; CPU execution and versioned result format.
- [ ] Fixture provenance/checksums and manifest validation.
- [ ] Load/first/warm latency, throughput, sampled RSS and snapshot footprint.
- [ ] Precision/recall@k and MRR verified against known ranking examples.
- [ ] Real pretrained encoder smoke run if a complete model can be staged.
- [ ] Report actual results and distinguish synthetic from representative quality.

Representative photo evaluation, selection of a production model, new service
contracts and production integration are follow-up work. This module may inform
those decisions; it does not make them.
