# ML similarity and duplicate suggestions

Date: 18 October 2026. Branch: `codex/ml-similarity`. Depends on the tested
semantic-search core, merged through the local `codex/ml-suite` branch.

Implemented nearest-photo retrieval excluding the source, scope/model filtering,
exact-byte duplicate identification and conservative near-duplicate suggestions.
Suggestions use complete-link groups: every pair must pass the threshold,
preventing misleading transitive groups. The operation never deletes source or
derived records and returns no raw vectors. Input is explicit, unique asset IDs
bounded to 256 per grouping request; large libraries require separate batches.

Validation: 2 focused similarity tests pass (in addition to the 5 search/client
checks). They verify scope isolation, source exclusion, deterministic grouping,
rejection of duplicate IDs/bad thresholds and the A~B~C chaining failure case.
Scores are similarity evidence, not proof that edited photos can be deleted.
