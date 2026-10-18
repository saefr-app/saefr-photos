# Standalone ML service candidate — specification

- Owner: Poorva's ML workstream.
- Authorized scope: the next module after the draft service contract.
- Date: 18 October 2026, Asia/Calcutta.
- Branch/base: `codex/ml-service-candidate` from `integration` at `68d6a1a`.

## Deliverable

An independent Python/FastAPI service candidate implementing the reviewed draft
image/text embedding interface, without NestJS, Redis or database integration.
Use the locally prepared CLIP baseline as a candidate adapter, not a production
model selection. Preserve the user's `dev` work and prior module worktrees.

## Acceptance and evidence

- [x] Authenticated inference/readiness, public liveness, localhost CLI default.
- [x] Exact local registry/model/preprocessing identity and no runtime downloads.
- [x] Real CPU image/text vectors conforming to the draft v1 result format.
- [x] Bounded in-memory multipart/JSON input, integrity/type/frame/pixel checks.
- [x] One inference slot, bounded request time, no overlapping abandoned work.
- [x] Over-context text rejected instead of silently truncated.
- [x] Focused tests for malformed input, corruption, model failure, saturation,
  timeout, request cancellation, registry tampering and process reinitialization.
- [x] Real-model HTTP smoke and isolated loopback process smoke, synthetic data only.
- [x] Container definition and explicit resource/deployment guidance supplied.
- [ ] Container build/run verified — blocked by stopped Docker daemon.

## Exclusions

No production model selection, public search endpoint, vector storage, queue,
canonical DB/schema changes, asset authorization implementation, deletion/index
orchestration, release, main merge or deployment. Backend-owned contract review
and lifecycle integration remain separate work. Container execution is recorded
as unverified rather than represented as a passing result.
