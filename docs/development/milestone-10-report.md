# Milestone 10 — Authentication Foundation summary

- **Status:** Implemented on `feat/m10-auth-foundation`; Phase 10B.6 awaits independent review and checkpoint approval. No PR or merge has occurred.
- **Approved contract:** [M10 specification](milestone-10-spec.md) and [ADR 0004](../decisions/0004-authentication-foundation.md).
- **Phase evidence:** [10B.2 database](milestone-10b2-report.md), [10B.3 credentials](milestone-10b3-report.md), [10B.4 browser sessions and lockdown](milestone-10b4-report.md), [10B.5 administration](milestone-10b5-report.md), [10B.6 final review](milestone-10b6-report.md).

## Implemented foundation

Phases 10B.1–10B.3 were checkpointed as `7c9fc9d`, 10B.4 as `d5d91d7`, and 10B.5 as `903b2a6`. M10 provides two strictly validated PostgreSQL tables through a new immutable Kysely migration, history-aware migration safety, Argon2id password handling, local first-admin bootstrap and password recovery, opaque revocable browser sessions, password change, default-deny account routes and administrator-only ordinary-user creation/list/disable. The API checks schema readiness but does not migrate at startup.

The production application does not mount `AssetsModule`. Its early Fastify boundary returns 401 for anonymous asset requests and a fixed 503 for authenticated users and administrators before multipart parsing, storage or legacy asset queries. No ownerless row was assigned to a user. Browser authentication and unrestricted ownerless media access never coexist in the production composition.

## Verified acceptance status

The final Phase 10B.6 run passed build, typecheck, lint, Prettier, 90 unit tests, 52 HTTP E2E tests, 91 real-socket/disposable PostgreSQL integration tests, 44 migration tests and runtime smoke. Both `postgres:18` tmpfs containers were removed. The expanded regressions cover asset aliases and methods, Origin/CSRF/unsupported credentials, restricted sessions and ordinary-user media denial. Earlier phase reports retain their original test counts, corrections and limitations. No development-database migration, media access, deployment, CI run or real backup/restore rehearsal was performed.

The M10 source/security review found no confirmed bypass requiring a production or schema change in Phase 10B.6. This is evidence for independent review, not a guarantee that all vulnerabilities have been excluded.

## Open security and release gates

- **Asset privacy:** M11 must map existing ownerless assets explicitly and add repository-level ownership/sharing authorization before asset routes are enabled. Administrators have no implicit media permission.
- **Real data:** Review compatibility, backups and restore procedures, rehearse an upgrade on an isolated restored copy and obtain separate approval before migrating the existing development database. The strict M8 baseline and historical versions remain unchanged.
- **Operations:** Validate production HTTPS, proxy trust, secure-cookie behavior, operator recovery and temporary-password delivery. The in-memory limiter resets on restart; Argon2 cost needs target-hardware measurement. An in-flight request may complete after revocation.
- **Media reliability:** Filesystem failure injection and crash reconciliation remain open from M9. Database metadata and files are not transactionally atomic.
- **Delivery:** Independent 10B.6 review, checkpoint approval, push and a separately approved `integration` PR remain. M10 is not a self-hostable photo release and `main` remains reserved for the validated alpha.

See the [Phase 10B.6 report](milestone-10b6-report.md) for exact final commands, test counts, changed files and repeat instructions.
