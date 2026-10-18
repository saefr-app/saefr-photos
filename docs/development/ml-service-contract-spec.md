# ML service-contract module — specification

- Owner: Poorva's ML workstream.
- Scope: next module authorized in chat after the research harness review.
- Date: 18 October 2026, Asia/Calcutta.
- Base: `integration` at `68d6a1a`.
- Branch: `codex/ml-service-contract` in a separate worktree.

## Deliverables

1. A proposed worker-to-inference interface for image and text embeddings,
   versioned model identity and results, error/retry semantics, repeat-safe job
   identity and lifecycle/deletion/re-index requirements.
2. Privacy/data requirements describing authorization boundaries and retention.
3. Executable draft wire validators, generated JSON Schemas and illustrative
   fixtures usable for later Python/TypeScript contract review.
4. Focused checks for invalid inputs, vector invariants, attempt correlation,
   stale results and artifact consistency.

## Acceptance criteria

- [x] Proposal status and backend dependencies explicit.
- [x] No current API/backend/schema/storage changes.
- [x] No arbitrary filesystem path or URL input in the image contract.
- [x] Exact model/preprocessing identity, finite vectors and dimension checks.
- [x] Retry/job identity separate from per-attempt correlation.
- [x] Stale/deleted/disabled/restored contexts rejected by illustrative gate.
- [x] Privacy and transactional integration requirements written down.
- [x] Published schema/example artifacts consistent with executable definitions.

## Exclusions

No running HTTP service, inference, queue, authorization implementation,
database/index, migration, deployment or production model selection. A passing
wire validator or pure function does not prove race-free persistence. The backend
must review the proposal before actual integration changes.
