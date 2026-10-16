# ADR 0002 — Planned background processing and ML boundaries

- **Status:** Accepted direction; **not implemented**

## Decision
When asynchronous work is introduced, use **Redis + BullMQ** with application/worker processes instead of switching to a PostgreSQL-backed job queue. Redis holds queue state; BullMQ is a Node library, **not** a standalone service container. Run long-lived work outside the HTTP request where appropriate.

Keep a separate Python-based ML inference service for future image/video intelligence; NestJS remains the primary API/orchestration service. The ML design may change after actual performance testing.

## Rationale
Retries, backoff, observability, decoupled workloads and an established ecosystem for media processing. Python simplifies reuse of ML tooling. Avoid complicating the initial API migration with a queue before the lifecycle, retry semantics and deployment are tested.

## Future acceptance criteria
Durable Redis configuration appropriate for jobs; idempotent processing; explicit state transitions; retry limits and dead/failed jobs; restarts and reconnection tests; careful handling of thumbnails created before metadata commits; documented resource limits.

## Not implemented
No Redis container, BullMQ worker, separate ML container, video processor, or automatic ML jobs in the current migration branch.
