# Durable ML processing

Date: 18 October 2026. Branch: `codex/ml-jobs`. Builds on the tested local ML suite.

Implemented BullMQ worker processing with a persistent SQLite ledger/outbox,
stable operation IDs, three-attempt durable budgets, transient/permanent error
classification, bounded jittered backoff, missed-queue reconciliation and
idempotent explicit operator retries. Queue messages contain only a generated
job ID; request metadata and state remain in owned local storage. Late results
are published with the original scope epoch and generation in one transaction.
Same-byte embeddings are reused only inside the same authorized scope/model.

Managed source copies are accepted through bounded streams into a private owned
cache, with byte/hash checks and a quota. This cache supports re-indexing and is
purged through lifecycle operations; it never points at the canonical library.

Validation: 3 focused worker/ledger tests pass, covering repeat-safe submits,
in-scope inference reuse, reconciliation after lost queue entries, bounded
attempts and sanitized permanent errors. Real Redis, real model and independent
runtime tests are completed by the combined integration module; these focused
tests deliberately inject inference and queue adapters.
