# ML service-contract module — completion report

- Status: ready for review; contract remains a draft proposal.
- Branch and base: `codex/ml-service-contract` from `integration` at `68d6a1a`.
- Date: 18 October 2026, Asia/Calcutta.
- Implemented commit: none; reviewable local files only.

## Goal and acceptance

Deliver the next independent Poorva module: the inference interface and data/
privacy requirements, made concrete with executable definitions and fixtures.
All acceptance criteria in [the specification](ml-service-contract-spec.md) are
met. This is not a running ML service or an accepted backend API.

## Changed files

| Path | Change | Reason |
| --- | --- | --- |
| `docs/ml/ml-service-contract-proposal.md` | Proposed image/text interface, limits, errors, model identity, jobs and lifecycle semantics | Let backend and ML review a concrete boundary |
| `docs/ml/ml-data-and-privacy-requirements.md` | Ownership, transient data, authorization, retention, deletion and acceptance scenarios | Define privacy responsibilities before integration |
| `contracts/ml/v1/contract.py` | Strict Pydantic models and pure comparison/integrity/job-key helpers | Make draft invariants executable |
| `contracts/ml/v1/schemas/` | Six generated JSON Schemas | Language-neutral wire shape review |
| `contracts/ml/v1/examples/` | Six generated illustrative fixtures | Concrete request/result/error/event examples |
| `contracts/ml/v1/test_contract.py` | Thirteen focused tests | Exercise numeric/integrity/stale-result behavior and artifact consistency |
| `contracts/ml/v1/export_schemas.py`, `make_examples.py` | Explicit artifact generators | Keep examples and schemas reproducible |
| `contracts/ml/v1/README.md`, `requirements.txt`, `.gitignore` | Usage, tested dependencies and cache exclusion | Independent execution without model runtime |
| `docs/development/ml-service-contract-{spec,report}.md` | Scope and evidence | Honest module handoff |

## Technical decisions

The shared baseline lacks authorization and lifecycle state. This module proposes
opaque scope IDs and monotonic generations but changes no database or current
asset DTO. Image bytes cross the boundary; arbitrary paths and URLs do not.
Inference callers must be authenticated and authorized by backend-controlled
mechanisms before reading source data. Specific credential provisioning and
deployment choices remain open.

Model revision, complete artifact/preprocessing identities and vector dimensions
are pinned. Responses must be finite unit vectors and match their request.
JSON Schema only captures wire shape; Python validators add cross-field checks.
The real Node consumer needs equivalent runtime validation before persistence.

Logical image-job identity excludes attempt UUID and includes source generation,
scope, content and model target. The helper tests the semantics without creating
a queue or table. Persistence eligibility is illustrated by a pure function;
actual lifecycle compare-and-set and derived-row publication must be atomic in
the future backend implementation.

A contract difference discovered during review is recorded explicitly: the
research benchmark truncates model inputs, while the proposed service must
reject over-token-limit text. The benchmark is unchanged on its own branch.

## Verification results

Environment: Python 3.13.7, Pydantic 2.11.7, jsonschema 4.26.0, Windows 11.
No database, Docker, real photo library or model inference involved.

| Command (from `contracts/ml/v1`) | Outcome | Evidence |
| --- | --- | --- |
| `python export_schemas.py` | PASS | Six draft schema files generated |
| `python make_examples.py` | PASS | Six fixtures validated and generated |
| `python -m unittest discover -v` | PASS, 13 tests | Wire/artifact and pure helper checks |
| Python/Node recursive-sorted JSON + SHA-256 fixture check | PASS | Independent Node crypto implementation produced the same job key as Python |
| Nest build/unit/E2E/lint/integration | NOT RUN | Backend/API/dependencies untouched |
| HTTP/service/privacy integration | NOT RUN | No HTTP server or integrated service implemented |

Covered cases include numeric coercion/overflow, unknown fields, URL/path
injection fields, unpinned revisions, invalid UUID/schema version, invalid vector
dimensions/norm/finite values, repeat-safe job IDs, changed generation/scope/model,
delete/disable/restore contexts, mismatched attempts/content and byte integrity.
Error fixtures are allowlisted and cannot contain raw exception details.

The schema artifact tests validate each schema and fixture and compare exported
artifacts against current Python definitions. Regeneration is not performed by
the test itself, so stale checked-in artifacts fail.

The independently checked image-request fixture job key is
`ml-v1-8da3f10b3854a91d624962dc05202582de78b41e95976d83b87a6eed832bb1dc`.
It is retained as a golden assertion in the retry/key test. This verifies the
fixture's cross-language encoding, not arbitrary future schema compatibility.

## Security and data safety

Only newly added contract/docs files are included. The user's original `dev`
checkout and the prior research worktree are preserved. Fixtures use invented
UUIDs/model digests/vectors and non-image placeholder bytes, clearly labeled.
No secrets, media or database settings were used. No migrations, deployments,
queues, model downloads or service requests occurred in this module.

## Remaining decisions and limitations

- Backend review of scope/generation persistence, internal authentication and
  the registry/derived-record design is still required before integration.
- No transaction, outbox/event delivery, access enforcement, deletion cleanup
  or vector database behavior has been implemented or proven.
- Production model choice still requires representative comparative evaluation;
  fixture dimensions and model IDs are not recommendations.
- A later service candidate must test decoding, ingress limits, tokenizer limits,
  saturation, restart, timeout/cancellation and model-unavailable behavior.
- No commit, push, merge or next module was performed as part of this delivery.

## Reproduction and review gate

Install the directory's pinned requirements in an isolated Python environment,
then run the three commands above. No infrastructure or personal data required.

- [ ] Backend/ML reviewers accept the proposed boundaries.
- [x] Focused checks passed and artifacts verified.
- [x] Limitations and unimplemented mechanisms documented.
- [ ] Concrete diff reviewed for commit/push.
- [x] Production integration and next module not started.
