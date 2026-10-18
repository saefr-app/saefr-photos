# ML use cases and priorities

Owner: Poorva. Research scope agreed in chat on 18 October 2026.
These priorities are proposals; production interfaces remain a team decision.

| Order | Capability | Evidence required before integration |
| --- | --- | --- |
| 1 | Local text-to-image semantic search | Paired image/text encoder, licensed dataset, useful relevance scores and CPU measurements |
| 2 | Similar-image retrieval | Same-image transformations and unrelated hard negatives; explicit false-positive review |
| 3 | Near-duplicate grouping | Separate evaluation of crops, edits and bursts; suggestions only, no automatic deletion |
| 4 | Optional tagging | Taxonomy, calibrated thresholds and misleading-label review |
| Later | Optional face grouping | Separate consent/privacy design, model-weight license review and deletion/access tests |

Exact-byte deduplication and semantic similarity are separate capabilities.
An embedding distance alone must not decide that a photo is safe to delete.
No requirement to implement all Immich features is implied by using it as a reference.

Start with English queries. Evaluate Marathi/Hindi or multilingual needs before
claiming language support. Keep all inference on the host. Model preparation
may download public artifacts separately; inference must not upload user data.

## First research module acceptance

- Reusable offline CLI and generated synthetic dataset.
- Verified ranking metrics, repeatable timings and environment/provenance records.
- Model and license shortlist with unknowns explicitly recorded.
- Honest distinction between harness verification and representative model evaluation.

## Integration dependencies

Production search requires backend-owned authorization and derived-data storage.
Worker payloads, retries, deletion propagation and re-indexing require an agreed
contract. This prototype changes none of those boundaries and does not read the
developer's database or photo library. The next service-contract proposal is a
separate module, after research results are reviewed.
