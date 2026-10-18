# ADR 0002 — Planned background processing and ML boundaries

- **Status:** Accepted direction; optional ML candidate implemented, canonical backend adoption pending

## Decision
When asynchronous work is introduced, use **Redis + BullMQ** with application/worker processes instead of switching to a PostgreSQL-backed job queue. Redis holds queue state; BullMQ is a Node library, **not** a standalone service container. Run long-lived work outside the HTTP request where appropriate.

Keep a separate Python-based ML inference service for future image/video intelligence; NestJS remains the primary API/orchestration service. The ML design may change after actual performance testing.

## Rationale
Retries, backoff, observability, decoupled workloads and an established ecosystem for media processing. Python simplifies reuse of ML tooling. Avoid complicating the initial API migration with a queue before the lifecycle, retry semantics and deployment are tested.

## Future acceptance criteria
Durable Redis configuration appropriate for jobs; idempotent processing; explicit state transitions; retry limits and dead/failed jobs; restarts and reconnection tests; careful handling of thumbnails created before metadata commits; documented resource limits.

## Implementation update — 2026-10-18
The optional core ML candidate now provides Redis, a separate Node BullMQ
coordinator/worker and a Python inference container, with an opt-in NestJS upload
bridge. See [the verification report](../development/ml-suite-report.md).
The standalone Node coordinator owns only derived ML state; this prototype does
not silently move canonical orchestration away from NestJS or select a new
canonical database. Production adoption remains subject to review.

Canonical thumbnail/video jobs, authenticated asset lifecycle events and a
transactional canonical outbox remain unimplemented. The optional bridge is
disabled by default. No first-alpha deployment or migration of real data is
claimed by the candidate's isolated synthetic tests.
