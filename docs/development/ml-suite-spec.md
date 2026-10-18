# Core ML batch implementation scope

The user's request to implement all remaining modules applies to Poorva's core
ML track in the supplied team roadmap. The roadmap is reference material; its
proposed future product milestones are not instructions to implement the entire
mobile/backend release in this batch.

## Acceptance criteria

- Keep inference in an independent offline Python service with a versioned
  request/result contract, pinned runtime and reproducible model identity.
- Persist scoped image embeddings and support local text search, similar photos
  and bounded duplicate suggestions without deleting assets.
- Run indexing in a separate BullMQ worker, with a durable SQLite job ledger,
  bounded retry/backoff, recovery, sanitized status and explicit retry controls.
- Fence publication by scope, generation, content, model and scope epoch;
  reject stale results after deletion, move, disable and model changes.
- Support trash/restore, permanent tombstones, opt-out purge and staged re-index
  with complete-coverage activation. Keep canonical originals outside ML storage.
- Provide explicit scoped capabilities, revocation checks, bounded inputs,
  private cache copies, quotas and restart-safe API write ownership.
- Add an optional local NestJS upload bridge, disabled by default; preserve
  upload success during ML failures and require separate existing-library opt-in.
- Supply resource-limited containers, setup/run documentation, CI workflow and
  synthetic-data tests. Prove real inference/queue/search/lifecycle/restart using
  isolated owned resources, without development database or media mounts.

## Release boundary

This is a local review candidate on module branches combined into
`codex/ml-suite`. It does not authorize modifying personal data, deploying,
pushing, or merging the first alpha to `main`. Authentication, canonical asset
ownership/lifecycle, mobile sync/video, face recognition and automatic tagging
remain separate workstreams. CLIP is a tested baseline rather than a final
product model selection. No canonical database migration is introduced.
