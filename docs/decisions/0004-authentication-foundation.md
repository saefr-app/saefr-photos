# ADR 0004 — Authentication foundation and the M10–M11 privacy boundary

- **Status:** ACCEPTED — maintainer approval for M10 architecture and Phase 10B.2, 2026-10-21
- **Scope:** Milestone 10 design only; no authentication code or schema is implemented by this document
- **Detailed proposal:** [M10 specification](../development/milestone-10-spec.md)

## Context

The current NestJS API exposes an ownerless `public.asset` table and local media through unrestricted asset endpoints. Individual accounts cannot safely be added by placing a login check around those endpoints: every signed-in user would still be able to enumerate and retrieve every legacy asset. The server operator controls the host, database and files; this proposal protects users from other application users, not from that operator.

## Proposed decision

1. Use closed provisioning. A local operator CLI creates the first administrator; application administrators may create ordinary accounts. There is no public signup or bootstrap endpoint.
2. Store Argon2id password hashes and issue opaque random browser session credentials. PostgreSQL stores only session-token hashes. The browser uses an HttpOnly cookie with a separate CSRF token and an explicitly configured same-origin policy. Authentication checks current account status for every request.
3. Separate server administration from photo ownership. Administrators may manage accounts but receive no implicit media access or impersonation capability.
4. Disable every production asset route for **all** callers until M11 supplies ownership data and authorization predicates. An anonymous request receives 401; a valid session receives a stable 503 with no asset-specific information. Retain the asset implementation for isolated component tests. Re-enable it only through a reviewed M11 change.
   **Ordering requirement:** Implement and verify this production lockdown before functional login is enabled in the application. Authentication components may be developed independently, but no intermediate runnable application may combine login with unrestricted ownerless asset routes.
5. Provide a local operator recovery command that changes a selected account password, revokes its sessions and requires a new password at next login. There is no public reset endpoint. Prevent the last active administrator from being disabled.
6. Keep the user UUID, session persistence and typed authenticated actor compatible with later clients. Defer native bearer transport until its client security contract is designed.
7. Add only new migration versions. Preserve the historical asset migration and strict legacy baseline. Validate schema according to applied migration history; keep migration execution explicit and separate from API startup.

## Why this approach

PostgreSQL-backed opaque sessions fit the existing database and single-node deployment plan. They allow immediate revocation without a signing-key rotation protocol or another service. Closed provisioning avoids an unaudited public registration and recovery surface. A structural asset lockdown makes the privacy boundary visible in application composition rather than relying only on a guard around ownerless queries.

## Alternatives considered

- **JWT or stateless sessions:** complicate immediate revocation and account-disable semantics; no current need.
- **Passport or a general permission framework:** adds abstractions before the ownership rules exist.
- **Public signup, email reset, invitation service or SSO:** adds identity and delivery infrastructure outside the initial self-hosted scope.
- **Administrator media bypass or automatic assignment of old assets:** would expose private ownerless media without a reviewed mapping.
- **Keeping current asset controllers mounted behind authentication:** a successful login would still authorize access to unrelated legacy media.
- **Native bearer tokens in M10:** require a separate device storage, lifecycle and credential precedence contract; session persistence can support them later.

## Trade-offs and remaining risks

- M10 intentionally makes asset APIs unavailable until M11. It is not a deployable multi-user photo server by itself.
- An administrator who supplies a temporary password can know that credential before the user changes it. Initial credential delivery remains an operator responsibility; avoiding that trust requires a later enrollment design.
- The host operator can access PostgreSQL and media files directly. M10 does not offer end-to-end encryption or protection from the host.
- A single-process in-memory login limiter is reset on restart and does not cover a future multi-node installation.
- Revocation cannot retract a response already authorized and in progress. Subsequent requests must reject the revoked session.
- Database/filesystem crash recovery, deployment TLS/proxy behavior and ownership backfill require separate work and validation.

## Acceptance gate

The maintainer approved this architectural direction and the ordering correction above in the Phase 10B.2 kickoff. Approval authorizes Phase 10B.2 database foundation work only. It does not authorize a migration against the development database, public exposure, a commit, a push or later phases.
