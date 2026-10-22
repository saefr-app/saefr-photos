# ADR 0005 — Asset ownership and authorization

- **Status: ACCEPTED — independently reviewed and approved by the maintainer on 2026-10-23.**
- **Date:** 2026-10-22
- **Scope:** M11 design only; Phase 11A does not implement schema or reopen routes.
- **Baseline:** merged M10, `acf6ed44bb870fdae56e68c523ba660af6536897`.
- **Detailed contract:** [M11 specification](../development/milestone-11-spec.md).

## Context and accepted constraints

[ADR 0004](0004-authentication-foundation.md) separates account administration from media access and requires production asset lockdown until reviewed ownership authorization exists. M10 implements that lockdown. The retained asset repository has no owner predicates, and its upload service publishes files before metadata insertion. All existing assets have no trustworthy owner information.

The threat boundary is between application accounts. The host operator controls PostgreSQL and the filesystem; this design does not protect against that operator. [ADR 0001](0001-backend-stack.md) remains the backend stack decision; [ADR 0002](0002-background-processing-and-ml.md) does not authorize workers here; [ADR 0003](0003-branching-and-first-alpha.md) retains independent review and integration/alpha gates.

## Decision

1. Add nullable `asset.owner_id UUID`, no default, referencing `app_user(id)` through non-deferrable `asset_owner_id_fkey`, `ON DELETE RESTRICT`, `ON UPDATE NO ACTION`, `MATCH SIMPLE`. Add non-unique B-tree `asset_owner_created_id_idx` on `(owner_id, created_at DESC, id DESC)`. Preserve all original columns, records, paths and files. Disabled accounts retain ownership.
2. Add an enforced `asset_owner_required_check CHECK (owner_id IS NOT NULL) NOT VALID` after the nullable column. It leaves historical NULLs in place while rejecting subsequent NULL inserts and updates. The maintainer explicitly accepted that an unrelated update to an ownerless row can fail until an approved owner is supplied. Keep the column nullable and the check unvalidated in both fresh and upgraded M11 schemas; do not silently validate it or set NOT NULL. No trigger, creation-time heuristic or legacy marker column.
3. Require the server-authenticated user UUID for every new application insert. The FK/check alone cannot prove caller identity or prevent direct SQL ownership transfer. Every read uses an owner predicate in SQL; storage opens only after a successful scoped lookup. Administrators receive no media bypass. NULL-owned rows remain invisible to everyone through HTTP.
4. Preserve browser sessions, exact Origin/CSRF checks and default-deny routing. Anonymous/invalid credentials receive 401; restricted sessions 403. Foreign, ownerless and nonexistent valid asset UUIDs share one sanitized 404. Malformed UUID is 400 only after authentication. HEAD, Range and aliases cannot bypass this policy.
5. Finish streaming/image work before starting a short upload transaction. Lock the user, then the current session; revalidate active/unrestricted state and expiry using database wall-clock time after acquiring locks; insert the actor's ownership and commit. Retain locks through completion. Revocation that wins these locks prevents insertion; upload that wins may commit before revocation. No locks throughout streaming or Sharp work.
6. Replace unconditional file compensation with outcome-aware compensation. Delete only this attempt's newly published files when metadata is known not to have committed. Retain files on uncertain commit or post-commit response failure; return a sanitized failure and record a safe diagnostic. Prefer a possible orphan over deleting committed media. No automatic reconciliation or atomic filesystem/database guarantee.
7. Append `202610220001_asset_ownership` in the separately authorized 11B implementation after a repeated collision check. Preserve historical M8/M10 migration files and their inspectors. Validate ledger structure/order before choosing the exact historical or M11 asset inspector. Startup checks readiness and never migrates. No M10/M11 mixed-version rollout; the old strict validator rejects the added schema.
8. Keep production routes locked through 11B schema and 11C scoped core work. In 11D, review early authorization, mounting, readiness and mounted-route negative tests as one boundary. No intermediate unscoped route, bypass flag or administrator exception. Defer optional 11E legacy mapping; newly owned galleries may work while old assets remain quarantined.

## Alternatives and trade-offs

- Application-only non-null enforcement is simpler but permits accidental ownerless inserts by alternate writers. The recommended unvalidated check is a small defense against that error, with an explicit restriction on legacy updates and backup/restore rehearsal requirements. PostgreSQL applies it to subsequent writes without requiring old rows to pass. See [PostgreSQL 18 ALTER TABLE](https://www.postgresql.org/docs/18/sql-altertable.html).
- Immediate NOT NULL or first-admin backfill would either fail on legacy rows or assign private assets without provenance. Both are rejected.
- RLS, per-owner directories, a generic permission engine and queues are unnecessary for this bounded milestone. Explicit repository predicates are reviewable but require negative tests on every path; they do not protect against privileged SQL access.
- Holding a user lock through image processing would serialize expensive uploads and delay account revocation. A short final transaction closes the write-authorization race without that cost.
- Deleting files after any database exception risks loss after an acknowledged-on-server but unacknowledged-on-client commit. Conservative retention has an orphan-storage cost; recovery remains separately designed.

## Consequences and acceptance

No ownership transfer, sharing, Family Space, mobile credentials, deletion, background workers or deployment is added. Future access grants must remain separate from ownership. In-flight authorized streams can finish after revocation. Unpaginated listing, resource bounds, filesystem failure injection and crash recovery remain documented limitations.

The maintainer approved the ownership schema and check's legacy-update restriction, owner-only HTTP policy, final upload locking and wall-clock expiry, conservative file compensation, legacy quarantine with optional 11E deferred, and the 11B–11F sequence after independent Phase 11A review. The [specification](../development/milestone-11-spec.md) defines exact phase files and tests, including disposable PostgreSQL upgrades, deterministic revocation races and real-socket media denial. This approval finalizes architecture only: M11 code, a real-data upgrade, route reopening, deployment and a merge each need their own authorization. Real-data upgrades require verified backups, recovery and an isolated rehearsal. No M11 schema or authorization code is implemented by accepting this ADR.
