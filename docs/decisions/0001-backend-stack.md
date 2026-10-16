# ADR 0001 — Backend stack

- **Status:** Accepted and implemented (initial phase)
- **Last verified:** commit `19b1467`, 2026-10-16 IST

## Decision
The primary backend is **NestJS 12 + TypeScript ESM** with the **Fastify** platform adapter, using **PostgreSQL 18**, **Kysely + pg**, and **Sharp** for initial image processing. Node runtime tracks `.nvmrc` (24). Current API source is `server-nest/`; `server/` remains a migration reference.

## Reasons
Modular organization for growth, typed SQL without an all-encompassing ORM, PostgreSQL durability, efficient HTTP and streaming, Sharp/libvips image processing, and TypeScript tooling. Keep concerns separated as controller → service → repository/storage.

## Consequences
Build and tests require Node and npm; PostgreSQL-backed integration tests need an isolated DB. Current handwritten Kysely types must be checked against actual schema. Streaming image uploads and file storage must be tested for size limits, crash recovery and authorization before public deployment.

## Not decided by this ADR
No claim that authentication, Dockerized API, video transcoding, BullMQ, ML or mobile clients are implemented. Those are separate milestones.
