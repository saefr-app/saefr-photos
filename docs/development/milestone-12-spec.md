# Milestone 12 — Manual Asset Lifecycle

**Status:** APPROVED — implementation contract; implementation not authorized

**Reference baseline:** `origin/integration` at `697980974009c1ea882b101805970396694b544f`.

**Architecture:** [Accepted ADR 0006](../decisions/0006-asset-lifecycle-and-deletion.md).

The maintainer approved the M12/M13 direction, **Option B: portable architecture in M12, staged storage certification before advertising additional environments as supported**, and the written contracts below. This specification is an implementation contract, not authorization to begin implementation.

## 1. Objective and scope

Implement:

- Cursor pagination on the existing asset-list endpoint.
- Reversible Trash/Restore with stale-command protection.
- Owner-only Trash listing and thumbnails.
- Permanent deletion accepted only from Trash.
- Durable deletion journals, operation discovery, status and explicit retry.
- Short token-guarded execution claims.
- A storage-provider boundary with capability-dependent support.
- Migration, security, crash-recovery and applicable platform verification.

Exclude:

- Redis/BullMQ and automatic retry.
- Scheduled Trash expiry.
- Bulk deletion or "Empty Trash."
- Orphan sweeping or automatic reconciliation.
- Legacy ownership mapping.
- Sharing, Family Space and ownership transfer.
- Mobile sync, upload idempotency and EXIF extraction.
- Object-storage implementations.
- Deployment and real-data operations.

M13 owns automatic expiry, retries and maintenance. The provisional 30-day expiry is not selected by this specification. Automatic Trash expiry and safe maintenance remain first-alpha requirements.

## 2. Existing guarantees and source of truth

Preserve:

- Owner predicates in SQL and no administrator media bypass.
- NULL-owner quarantine.
- Early authentication, restricted-session denial and unsafe-method Origin/CSRF checks.
- Original-byte preservation and current upload limits.
- Outcome-aware upload compensation, including retention after uncertain commits.
- Exact schema readiness without automatic migration.
- Historical migration and inspector immutability.
- Separate approval for Git operations, adoption, migration and deployment.

Follow [AGENTS.md](../../AGENTS.md), [team workflow](../team-workflow.md), [ADR 0005](../decisions/0005-asset-ownership.md) and the [migration guidance](database-migrations.md). Historical [M11 evidence](milestone-11-postmerge-report.md) does not certify M12 or additional platforms.

## 3. Lifecycle model

| State            | Representation                           | Permitted owner access               |
| ---------------- | ---------------------------------------- | ------------------------------------ |
| Active           | Asset row, `trashed_at IS NULL`          | Existing metadata/original/thumbnail |
| Trashed          | Asset row, `trashed_at IS NOT NULL`      | Trash metadata and Trash thumbnail   |
| Deletion pending | Journal with no completion; no asset row | Deletion status/retry only           |
| Deleted          | Completed journal; no asset row          | Deletion receipt only                |

Trash and Restore do not modify media bytes or `created_at`. Permanent-deletion acceptance is irreversible. Filesystem failure does not restore access.

## 4. Database schema

### 4.1 Asset additions

| Column              | Type        | Nullability/default      |
| ------------------- | ----------- | ------------------------ |
| `trashed_at`        | TIMESTAMPTZ | NULL allowed; no default |
| `lifecycle_version` | BIGINT      | NOT NULL; default `0`    |

Add enforced, validated checks:

- `asset_lifecycle_version_check`: `lifecycle_version >= 0`.
- `asset_trashed_at_finite_check`: `trashed_at IS NULL OR isfinite(trashed_at)`.

Rules:

- Actual Trash/Restore transitions increment the version exactly once.
- Same-state commands with the current version are no-ops.
- Stale versions fail even if the requested state already matches.
- Version overflow fails safely without mutation.
- API versions use decimal strings, never unsafe JavaScript numbers.
- No ownerless-row backfill or ownership inference occurs.

Retain the M11 ownership FK, unvalidated enforced owner-required check and existing ordering index. Add these non-unique B-tree indexes:

```sql
CREATE INDEX asset_active_owner_created_id_idx
ON asset (owner_id, created_at DESC, id DESC)
WHERE trashed_at IS NULL;

CREATE INDEX asset_trash_owner_trashed_id_idx
ON asset (owner_id, trashed_at DESC, id DESC)
WHERE trashed_at IS NOT NULL;
```

### 4.2 Deletion journal

Create `asset_deletion`:

| Column                       | Type        | Nullability/default |
| ---------------------------- | ----------- | ------------------- |
| `asset_id`                   | UUID        | PRIMARY KEY         |
| `owner_id`                   | UUID        | NOT NULL            |
| `accepted_lifecycle_version` | BIGINT      | NOT NULL            |
| `storage_id`                 | UUID        | NOT NULL            |
| `originals_binding_id`       | UUID        | NOT NULL            |
| `thumbnails_binding_id`      | UUID        | NOT NULL            |
| `storage_layout_version`     | SMALLINT    | NOT NULL            |
| `original_extension`         | VARCHAR     | NOT NULL            |
| `requested_at`               | TIMESTAMPTZ | NOT NULL            |
| `completed_at`               | TIMESTAMPTZ | NULL allowed        |
| `last_error_code`            | VARCHAR     | NULL allowed        |
| `execution_token`            | UUID        | NULL allowed        |
| `execution_expires_at`       | TIMESTAMPTZ | NULL allowed        |

No column defaults. Application SQL supplies required values explicitly.

Relationships:

- `asset_deletion_pkey` on `asset_id`.
- `asset_deletion_owner_id_fkey`: references `app_user(id)`, DELETE RESTRICT, UPDATE NO ACTION, MATCH SIMPLE, non-deferrable.
- No FK to `asset`.
- Binding UUIDs identify adopted storage locations; they do not reference an invented storage-management table.

The two binding IDs are necessary because originals and thumbnails can reside on independently mounted storage.

### 4.3 Exact journal checks

All checks are enforced and validated:

| Name                                   | Expression                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `asset_deletion_version_check`         | `accepted_lifecycle_version >= 0`                                                                                |
| `asset_deletion_layout_check`          | `storage_layout_version = 1`                                                                                     |
| `asset_deletion_extension_check`       | `original_extension IN ('.jpg', '.png', '.webp')`                                                                |
| `asset_deletion_requested_at_check`    | `isfinite(requested_at)`                                                                                         |
| `asset_deletion_completed_at_check`    | `completed_at IS NULL OR (isfinite(completed_at) AND completed_at >= requested_at)`                              |
| `asset_deletion_claim_pair_check`      | `(execution_token IS NULL) = (execution_expires_at IS NULL)`                                                     |
| `asset_deletion_expiry_check`          | `execution_expires_at IS NULL OR isfinite(execution_expires_at)`                                                 |
| `asset_deletion_completed_state_check` | `completed_at IS NULL OR (execution_token IS NULL AND execution_expires_at IS NULL AND last_error_code IS NULL)` |

`asset_deletion_error_code_check` allows NULL or exactly:

```text
storage_unavailable
storage_identity_mismatch
unsupported_storage
unexpected_file
permission_denied
filesystem_error
durability_unavailable
inconsistent_state
unknown_outcome
```

Add:

```sql
CREATE INDEX asset_deletion_pending_owner_requested_id_idx
ON asset_deletion (owner_id, requested_at DESC, asset_id DESC)
WHERE completed_at IS NULL;
```

No lease-expiry scanning index or job scheduler is required in M12.

### 4.4 Journal invariants

After insertion, these fields never change through application code:

- Asset and owner IDs.
- Accepted lifecycle version.
- Storage-set and binding IDs.
- Layout version.
- Original extension.
- Request timestamp.

Only claim fields, safe diagnostic category and completion timestamp may change. There are no private filenames, arbitrary absolute paths, credentials or photo contents in the journal.

These are application write-contract invariants; PostgreSQL CHECK constraints do not establish old-versus-new immutability. Repository methods and tests must restrict updates accordingly. Privileged database operators remain outside the application threat boundary.

Retain pending and completed receipts throughout M12. No purge command is added.

### 4.5 Database-wide storage provenance

Add one `storage_binding` installation record, not per-asset storage fields or a storage registry:

| Column                   | Type     | Nullability/default     |
| ------------------------ | -------- | ----------------------- |
| `singleton`              | BOOLEAN  | PRIMARY KEY; no default |
| `storage_id`             | UUID     | NOT NULL; no default    |
| `originals_binding_id`   | UUID     | NOT NULL; no default    |
| `thumbnails_binding_id`  | UUID     | NOT NULL; no default    |
| `storage_layout_version` | SMALLINT | NOT NULL; no default    |

Exact enforced, validated constraints:

- `storage_binding_pkey` on `singleton`.
- `storage_binding_singleton_check`: `singleton = TRUE`, permitting at most one row.
- `storage_binding_roles_check`: `originals_binding_id <> thumbnails_binding_id`.
- `storage_binding_layout_check`: `storage_layout_version = 1`.

No other indexes, foreign keys or defaults are added to this table. Its presence binds the complete asset population, including legacy NULL-owned rows, to one adopted storage set. It does not change ownership or authorize access to quarantined assets. An empty table means **unadopted**, never "use current configuration."

Only the separately authorized, stopped-service provisioning/adoption procedure may insert the row. Normal application code has no update/delete/rebinding operation. As with journal immutability, this is an application write contract; CHECK constraints do not prevent privileged operator updates. M12 does not support multiple simultaneous asset storage sets or per-asset relocation.

## 5. Migration and validation

Candidate immutable migration version: `202610260001_asset_lifecycle.ts`. Recheck identifier availability before implementation.

Required:

1. Append the migration to the explicit provider.
2. Add a separate M12 inspector.
3. Preserve M8/M10/M11 migrations and inspectors unchanged.
4. Dispatch validation using the exact supported migration-history prefix.
5. Reject partial or incompatible lifecycle objects before applying destructive assumptions.
6. Require M12 readiness for M12 application composition.
7. Never migrate during API startup.

The inspector validates:

- Nine asset columns and their exact contracts.
- Preserved historical constraints/defaults.
- Exact added indexes and predicates.
- Journal columns, PK/FK/checks/indexes.
- The exact `storage_binding` table contract in section 4.5.
- Constraint validation/enforcement and FK properties.
- No unexpected lifecycle defaults or objects.

Fresh installation, managed M11 upgrade and explicit legacy baselining must converge on the same M12 schema. Repeated execution is a no-op; concurrent execution uses the existing migration locking infrastructure.

Adding lifecycle columns must not issue a bulk UPDATE against quarantined rows. Historical asset values and migration entries remain unchanged. Historical NULL-owned rows retain NULL ownership and receive lifecycle version `0` through the new column's default.

Older binaries are incompatible with the new strict schema. No mixed M11/M12 rollout or automatic downgrade is supported. A rollback must not discard Trash state or deletion journals.

Real-data upgrades require separately approved backups, restore rehearsal and execution procedures.

The new migration creates `storage_binding` empty on both fresh installations and upgrades. It does not inspect media, infer provenance, create markers or adopt existing assets. Exact schema readiness and storage adoption are separate checks: an unadopted database can have a valid M12 schema, but upload publication, media reads and new deletion acceptance fail closed until explicit initialization/adoption succeeds. Repeated migrations preserve an existing anchor unchanged. Historical migrations and asset rows receive no storage-identity backfill.

## 6. Pagination contract

### Routes and ordering

| Collection        | Route                          | Descending key           |
| ----------------- | ------------------------------ | ------------------------ |
| Active gallery    | `GET /api/v1/assets`           | `created_at, id`         |
| Trash             | `GET /api/v1/assets/trash`     | `trashed_at, id`         |
| Pending deletions | `GET /api/v1/assets/deletions` | `requested_at, asset_id` |

Query parameters:

- `limit`: default **50**, range **1–100**; decimal integer only.
- `cursor`: optional continuation token.

Reject invalid, duplicate and unsupported parameters with sanitized `400`. Empty cursor, fractional/signed limits and array values are invalid.

Fetch `limit + 1`; return at most `limit`. No offset, unbounded fallback or total-count query.

### Response

```json
{
  "items": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "filename": "example.jpg",
      "mime_type": "image/jpeg",
      "size": 12345,
      "created_at": "2026-10-26T10:00:00.123Z",
      "lifecycle_version": "0"
    }
  ],
  "next_cursor": null
}
```

Trash items additionally contain `trashed_at`. The existing listing array is intentionally replaced. Update OpenAPI, examples and callers together.

Existing upload and single-asset metadata bodies retain their current fields; lifecycle ETags are added.

### Cursor

Base64url-encoded JSON:

```json
{
  "v": 1,
  "owner": "22222222-2222-4222-8222-222222222222",
  "collection": "active",
  "timestamp": "2026-10-26T10:00:00.123456Z",
  "id": "11111111-1111-4111-8111-111111111111"
}
```

Validation:

- At most 1,024 encoded bytes; bound input before decoding/parsing.
- Strict encoding, JSON object and exact fields.
- Version `1`.
- Canonical UUIDs.
- Valid UTC calendar timestamp with six fractional digits.
- Collection `active`, `trash` or `pending-deletions`, matching the route.
- Owner matching the authenticated actor.

Owner predicates always use the authenticated actor, not cursor authority. All SQL values are parameters. An unsigned cursor is a position, not an authorization capability. Do not echo invalid cursors in errors.

Project cursor timestamps directly from PostgreSQL with microsecond precision; do not convert through JavaScript `Date`. Use:

```sql
(timestamp_column, id_column) < (:timestamp, :id)
```

Derive the next cursor from the last returned row when an extra row exists; otherwise return NULL. Unsupported historical timestamp representations fail safely without rewriting data.

Pagination is a live view, not a snapshot or mobile change feed. Concurrent uploads and lifecycle transitions may change later pages.

## 7. HTTP lifecycle contracts

All routes retain early authentication. Restricted sessions receive `403`; foreign, NULL-owned and nonexistent valid asset IDs receive indistinguishable `404` responses. Malformed UUID handling follows M11: only after authentication.

Unsafe methods require the existing exact-Origin and CSRF protections. All asset/deletion responses retain the existing no-store and nosniff protections.

### 7.1 Lifecycle preconditions

Strong ETag:

```http
ETag: "asset-lifecycle:11111111-1111-4111-8111-111111111111:4"
```

Mutations submit the same value in `If-Match`. Reject weak, wildcard and multiple tags. The UUID must match the route.

After establishing owner access:

- Missing precondition: `428`.
- Malformed precondition: `400`.
- Stale version: `412`.

The list's UUID/version fields are sufficient to construct the documented tag. Version failures must not reveal foreign resource state.

### 7.2 Trash and Restore

```http
POST /api/v1/assets/:assetId/trash
POST /api/v1/assets/:assetId/restore
```

Empty body required. Successful response: `200`, resulting ETag and:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "state": "trashed",
  "trashed_at": "2026-10-26T10:10:00.123456Z",
  "lifecycle_version": "5"
}
```

Restore returns `state: "active"` and `trashed_at: null`. Actual Trash uses database wall time; neither operation changes files or `created_at`.

Normal metadata/original/thumbnail routes return `404` for trashed assets. Same-state commands with the current version return the unchanged result.

### 7.3 Trash preview

```http
GET /api/v1/assets/trash/:assetId/thumbnail
```

Only the unrestricted owner of a currently trashed asset may access it. Active, foreign, quarantined and deletion-pending/completed assets are denied.

Use the existing safe streaming/error mechanisms and private no-store policy. No Trash original-download route is added.

### 7.4 Permanent deletion

```http
DELETE /api/v1/assets/:assetId
If-Match: "asset-lifecycle:11111111-1111-4111-8111-111111111111:5"
```

Empty body, current owner authorization, Trash state and matching version are mandatory. An active asset returns `409`; deletion never implicitly trashes it.

Known unsupported storage capability or invalid binding prevents new acceptance. A storage failure after acceptance leaves a pending operation. After confirmed acceptance, perform at most one execution attempt within the bounded request policy.

Responses:

- `200`: completion confirmed.
- `202`: acceptance confirmed, still pending.
- `503`: acceptance/result cannot be established safely, or required storage is unavailable before acceptance.

Accepted responses include:

```http
Location: /api/v1/assets/deletions/11111111-1111-4111-8111-111111111111
```

```json
{
  "asset_id": "11111111-1111-4111-8111-111111111111",
  "status": "pending",
  "requested_at": "2026-10-26T10:15:00.123456Z",
  "completed_at": null,
  "last_error_code": "storage_unavailable"
}
```

Completed responses use `status: "completed"`, a non-NULL completion timestamp and NULL error code. `202` does not promise scheduled execution.

A repeated DELETE with the accepted version returns the same operation status. It does not create another journal or implicitly retry filesystem work. A different supplied version returns `412` after owner-scoped receipt lookup; a missing or malformed precondition follows the same 428/400 rules. Resolve an existing receipt before requiring current storage availability for a new acceptance.

### 7.5 Status and retry

```http
GET /api/v1/assets/deletions/:assetId
POST /api/v1/assets/deletions/:assetId/retry
```

- Owner only.
- Unknown/foreign operation: `404`.
- GET returns `200` with the operation representation.
- Retry requires empty body, Origin and CSRF.
- Retry needs no lifecycle precondition: the target is already immutable.
- Retry returns `200` completed or `202` pending/busy; database uncertainty/unavailability may return sanitized `503`.
- A completed operation is a no-op with no filesystem deletion.

Pending-operation listing uses the pagination envelope with operation representations. Completed receipts remain available individually. The asset UUID makes a lost acceptance response discoverable without a separate client idempotency key.

Do not expose execution tokens, storage identities, mount paths or raw errors. Test static `trash`/`deletions` routes against UUID-route precedence.

### 7.6 Error messages

Use the existing sanitized envelope with fixed messages:

| Status | Message                      |
| ------ | ---------------------------- |
| 400    | `Invalid request`            |
| 401    | `Unauthorized`               |
| 403    | `Forbidden`                  |
| 404    | `Asset not found`            |
| 409    | `Asset must be in Trash`     |
| 412    | `Lifecycle version conflict` |
| 428    | `Lifecycle version required` |
| 503    | `Service unavailable`        |

Preserve appropriate existing upload/parser errors. Unexpected failures remain sanitized `500`. Logs retain useful allowlisted categories without credentials, raw SQL, private filenames or internal paths.

## 8. Acceptance, authorization and identifier safety

Filesystem preflight occurs outside the transaction. It is not a substitute for execution-time validation.

Preflight must read the adopted `storage_binding` singleton and independently verify both role bindings against that record and configuration. Matching filenames or markers selected solely by current configuration are insufficient. Missing/uncertain provenance or any mismatch returns the existing sanitized `503` without accepting deletion. Inside the acceptance transaction, read the singleton with a shared row lock, require the same tuple verified by preflight, and copy journal identities from that row. No filesystem work occurs under this lock. All adoption/relocation/restoration procedures require stopped writers/executors; the application never rebinds the singleton concurrently.

For lifecycle mutations:

1. Lock the user.
2. Lock the session.
3. Acquire any required per-asset transaction coordination.
4. Lock the owner-scoped asset.
5. Recheck account state, restrictions and expiry using database wall time after waits.
6. Apply the transition or acceptance.
7. Commit.

Use READ COMMITTED and preserve M11's user-then-session order. Deletion acceptance inserts the journal and removes the asset atomically.

Use durable PostgreSQL settings for acceptance and completion; no asynchronous commit acknowledgement. API startup never changes database-server durability settings.

If acceptance COMMIT is uncertain, only a positive independent read of the matching journal authorizes execution. An absent lookup is not proof of rollback while the original transaction may be unresolved. Return a safe unavailable response rather than deleting speculatively. Never recreate the asset or delete the journal to compensate for uncertainty.

### Identifier reuse

Clients never choose upload asset IDs. Check generated IDs against assets and retained receipts before publication and again before committing metadata. A prepublication check alone is not an atomic reservation.

The final insert and deletion-acceptance paths must serialize their same-ID database decisions using a shared, short transaction-scoped per-asset lock. They must reject insertion of an ID present in the journal. This coordination occurs only in database transactions, never throughout streaming or filesystem work. The lock-key derivation and common acquisition order must be documented and tested; a lock-key hash collision may cause extra serialization, never authorization or target substitution.

An exceptionally delayed colliding upload must fail rather than become a new committed asset under an irreversible deletion target. Preserve conservative compensation and report uncertain publication outcomes. Do not overwrite an existing file or treat another attempt's file as owned cleanup material.

### Races

| Race                                | Required result                                  |
| ----------------------------------- | ------------------------------------------------ |
| Restore commits first               | Old deletion version fails; no unlink            |
| Acceptance commits first            | Restore returns 404                              |
| Concurrent acceptance               | One journal                                      |
| Concurrent lifecycle transitions    | One effective transition; stale competitor fails |
| Revocation wins authorization locks | No new acceptance                                |
| Acceptance wins first               | Execution may finish after revocation            |
| Stream already authorized/open      | May finish                                       |
| Unknown acceptance COMMIT           | No unlink without positive journal confirmation  |

Retry authorization does not undo or recreate committed authority. Later account disabling can prevent further owner HTTP requests without cancelling the accepted deletion; M13 may execute that existing intent under its reviewed worker policy.

## 9. Execution claims

### Approved operational defaults

- Claim duration: **60 seconds**.
- Maximum active deletion attempts per API process: **2**.
- No unbounded waiting queue.
- Request attempt budget: **30 seconds for starting further work**.

These are coordination/resource defaults, not correctness assumptions or hard syscall deadlines. They do not establish a global multi-process concurrency limit.

### Acquisition

After reserving a local execution slot, atomically claim a pending journal when:

```text
execution_token IS NULL
OR execution_expires_at <= database wall time
```

Set a new random token and expiry using database time. Clear an obsolete diagnostic when a new attempt starts. Return completed without filesystem work if the receipt is already complete.

If another unexpired claim exists, return pending without filesystem work. If the claim commit is uncertain, independently confirm that the same token is committed and unexpired before issuing an operation.

No database connection or transaction remains held during filesystem calls. A live asset row with the journal's UUID is an inconsistent state: fail closed without removal.

Before filesystem work, require the journal's immutable storage tuple to match the database anchor as well as both provider bindings and configuration. Missing or inconsistent provenance leaves the operation pending; do not replace journal identities to make a retry succeed.

### Renewal and result updates

Renew only where:

- The journal is pending.
- The token matches.
- The claim is still unexpired.

Check/renew before each additional destructive or durability step. No heartbeat timer or automatic retry scheduler is added in M12. An expired attempt does not silently acquire a fresh claim and continue; a later explicit request may retry.

Completion requires the same current, unexpired token and the provider's complete result. Record atomically:

```text
completed_at = greatest(database wall time, requested_at)
last_error_code = NULL
execution_token = NULL
execution_expires_at = NULL
```

Failure updates are also token-guarded. Clear the claim only after this attempt has no outstanding filesystem call. Otherwise allow it to expire. Diagnostic persistence is best effort when the database is unavailable.

A stale attempt cannot clear another claim, replace another diagnostic or change a completed receipt.

### Overlap and connection loss

Claims are not filesystem fencing. If a call outlives the claim, another request may execute the same immutable target. Both operations must be safe to repeat.

When a process discovers claim loss or database unavailability:

- It starts no further destructive steps.
- It observes/drains already issued promises.
- It does not report unconfirmed completion.
- A later owner request may retry.

A lost completion acknowledgement is resolved by reading the receipt. No files are recreated. Do not claim exactly-once execution or strict exclusion of stale filesystem calls.

### Cancellation

Do not release a storage concurrency slot merely because an HTTP timeout occurred. The underlying call may still be running. After cancellation or budget exhaustion, issue no further filesystem operations. Do not launch a detached replacement attempt.

A blocked NAS call can still outlive the request; the design prevents it from holding a PostgreSQL transaction or connection. Bounded provider I/O and safe shutdown behavior must account for operations that cannot be cancelled.

## 10. Storage-provider contract

### Logical targets

Application services supply:

```text
storage set ID
originals/thumbnail binding ID
layout version
asset UUID
rendition
approved original extension
```

They do not supply arbitrary filesystem paths. Layout version `1` maps to:

```text
originals/<UUID><extension>
thumbnails/<UUID>.jpg
```

Canonical names use the application's UUID representation. Future layouts require explicit implementation and migration validation; old receipts must not be interpreted under a different layout.

### Required operations

| Operation           | Contract                                                       |
| ------------------- | -------------------------------------------------------------- |
| Inspect binding     | Verify configured/adopted namespace and availability           |
| Create staging file | Exclusive, private, attempt-owned creation                     |
| Publish             | Complete-file publication without replacing an existing target |
| Open                | Authorized regular-file streaming with containment protections |
| Remove exact target | Remove only the specified immutable target; repeat-safe        |
| Confirm durability  | Satisfy the certified removal-persistence contract             |

Keep image validation and thumbnail orchestration separate from platform mechanics. No interface accepts recursive deletion or unrestricted path removal. Provider operations do not confer user authorization.

### Capabilities

Profiles record supported, unsupported or unverified behavior for:

- Exclusive staging.
- Complete-file/no-replace publication.
- Path containment and symlink/reparse protections.
- Storage binding validation.
- Authoritative absence.
- Repeat-safe exact deletion.
- Publication and removal durability.
- Open-file deletion behavior.
- Cancellation limitations.
- Permission enforcement.

Profiles are versioned implementation/certification artifacts. Configuration selects a profile; it cannot turn an unverified capability into a supported one. OS names or successful one-off probes do not certify filesystem durability.

### Error outcomes

Providers distinguish:

- Removed/authoritatively absent.
- Temporarily unavailable or busy.
- Permission/configuration failure.
- Identity mismatch.
- Unexpected target.
- Unsupported capability.
- Unknown outcome.

`ENOENT` is not sufficient by itself. Parent/binding verification must establish absence on the intended storage. Missing parents, `ENOTDIR`, symlink loops, stale handles and I/O errors are not successful removal.

Never automatically clear permissions, replace markers, follow unexpected redirects or create directories to make deletion succeed. Do not scan for related files. Only the two journal-derived canonical targets are in scope.

## 11. Existing M11 storage compatibility work

The separately reviewed compatibility package must address:

1. Hard-link publication capability and safe alternatives.
2. POSIX `O_NOFOLLOW` versus Windows reparse/handle behavior.
3. POSIX modes versus Windows ACLs.
4. Case, separator and canonical-path behavior.
5. Independently mounted media directories.
6. Directory recreation when a mount disappears.
7. Safe distinction between absent and inaccessible targets.
8. Streaming/open-handle behavior on each supported profile.
9. Attempt-owned staging cleanup.
10. Publication and removal durability.
11. Historical stored-path interpretation across Windows/POSIX.

Node does not provide identical filesystem flags or permission behavior across platforms and does not guarantee atomic copying. A copy or ordinary rename must not silently replace safe no-overwrite publication. See [Node filesystem documentation](https://nodejs.org/docs/latest-v24.x/api/fs.html).

Historical `storage_path` values are not rewritten. For layout 1, validate their canonical filename using explicitly supported legacy path syntax, then use the configured logical binding. Never follow a stored absolute path to select an arbitrary deletion target.

This filename interpretation is permitted only after database-wide adoption proves the historical population belongs to that binding. A basename match does not establish provenance or authorize treating an unrelated configured root as historical storage.

Preserve current image limits, streaming backpressure, multipart completion and byte integrity. A required capability must fail closed; unknown Windows/NAS behavior is not an acceptable fallback.

If publication outcome is uncertain, retain potentially published files and return a sanitized failure. The provider must not claim ownership of an existing file merely because a timed-out publication found that name afterward.

The existing upload-compensation helper remains separate from permanent deletion. It must not become a general deletion bypass. Additional native adapters or dependencies require focused justification and approval before implementation; Option B does not require all of them to ship in M12.

## 12. Binding identity, adoption and restoration

### Configuration

Non-secret settings:

```text
STORAGE_ID
STORAGE_ORIGINALS_BINDING_ID
STORAGE_THUMBNAILS_BINDING_ID
STORAGE_ORIGINALS_PROFILE
STORAGE_THUMBNAILS_PROFILE
```

Retain `STORAGE_ROOT`; layout 1 uses its `originals` and `thumbnails` locations. Each location contains a bounded regular `.saefr-storage.json` marker. Configuration locates candidates; it never supplies proof of physical identity or permission to adopt them.

### Marker version 2

The exact initial Linux/ext4 marker shape is below. Values illustrate encoding only; this example is not adoption evidence or a certified physical observation.

```json
{
  "version": 2,
  "storage_id": "33333333-3333-4333-8333-333333333333",
  "binding_id": "44444444-4444-4444-8444-444444444444",
  "role": "originals",
  "physical_identity": {
    "format": "linux-ext4-handle-v1",
    "profile": "linux-ext4-v1",
    "filesystem_uuid": "55555555-5555-4555-8555-555555555555",
    "directory_handle_type": 1,
    "directory_handle_hex": "0102030405060708",
    "location_sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  }
}
```

Normative parsing and encoding:

- Read at most 1,025 bytes from the safely opened regular marker file; reject anything exceeding 1,024 bytes, including whitespace. Decode strict UTF-8 without a BOM; reject malformed encoding, invalid JSON, trailing non-whitespace content, duplicate decoded property names at any level, unknown/missing fields, arrays/null in place of objects and wrong value types. JSON whitespace and object-key order are insignificant to readers; never coerce strings/numbers or ignore extra fields.
- The top-level keys are exactly `version`, `storage_id`, `binding_id`, `role`, `physical_identity`. `version` is the JSON integer value `2`; `role` is exactly `originals` or `thumbnails`. UUIDs are non-nil lowercase ASCII hexadecimal in `8-4-4-4-12` form, with no braces, trimming or case conversion. This lexical rule does not assume a particular UUID generation version. Logical IDs must match the database singleton; role binding IDs remain distinct.
- For `format: "linux-ext4-handle-v1"`, the nested keys are exactly those shown. `profile` is exactly `linux-ext4-v1` and must match that role's configured profile and the adapter's certified capability/environment checks. These names reserve the initial candidate format/profile; a marker naming them does not certify the environment. Unknown formats/profiles are rejected; future profiles require separately reviewed exact formats and certification, not arbitrary JSON extensions.
- `filesystem_uuid` is observed from the actual filesystem, with the same canonical UUID representation. `directory_handle_type` is a JSON integer in the signed 32-bit range, supported by the certified adapter. `directory_handle_hex` is lowercase ASCII hex of even length 2–256, representing 1–128 opaque bytes; no prefix, separators or padding. Compare type and decoded bytes exactly, without interpreting inode/generation subfields. Unsupported types or larger native handles fail closed rather than being truncated or hashed into an assumed equivalent.
- `location_sha256` is exactly 64 lowercase ASCII hex characters encoding the SHA-256 digest defined below. It pins the application-visible location approved at provisioning/cutover; it is not evidence of filesystem identity or a secret.
- Writers emit compact JSON with keys in the example order, no BOM and exactly one trailing LF, within the same byte limit. Create markers exclusively with restrictive provider permissions and the required file/directory persistence. Only explicitly approved relocation/restoration may re-establish a marker; normal operations never overwrite, repair or regenerate one.

For the initial Linux profile, capture the absolute process working directory at startup. Resolve `STORAGE_ROOT` against it and append the role using POSIX lexical path resolution: collapse repeated `/`, remove `.` and resolve `..`, retaining a single leading `/` and no trailing slash. Use that normalized absolute role path for both observation and I/O, never the unnormalized spelling. Reject NUL, U+0001–U+001F, U+007F and invalid Unicode scalar sequences in path input; do not trim, case-fold or Unicode-normalize path characters. Reject symbolic links in every directory component, including the root's ancestors, instead of following them to obtain a canonical path. Hash exactly the UTF-8 bytes of `saefr-role-location-v1`, one NUL byte, the ASCII role, one NUL byte and the normalized absolute role path, with no trailing NUL/newline. Alternate spellings resolving to the same lexical path have the same fingerprint; a different application-visible path requires controlled cutover even if it reaches the same physical directory. Later platform formats must define their own path rules before certification.

Marker format version **2** is independent of database `storage_layout_version = 1`; neither the singleton nor journal schema changes. Version 1 markers without physical evidence remain unverified. Startup and ordinary media operations must never upgrade them implicitly.

Markers are not credentials. They detect accidental copied-marker substitution only by comparison with fresh physical observations. No additional mandatory external runtime installation receipt is required.

### Validation and physical observation

The database singleton is the logical provenance authority. Before uploads, media reads or new deletion acceptance, require its identities/layout to match configuration and both observed role bindings. A changed root must identify the same adopted storage through a verified location change, not an unrelated directory with similarly named files. Physical identity establishes continuity after adoption; it cannot prove the historical correctness of first pairing.

For each role independently, the provider must safely open the actual role directory, read its marker without following a symlink, and obtain the filesystem UUID and opaque directory handle for that same opened directory/filesystem. Compare fresh evidence and the location fingerprint with the recorded marker, and logical identities with the anchor, configuration and applicable journal. Associate observations with the currently mounted filesystem; detect inconsistent observations or replacement around acquisition and before operations using the certified adapter's handle-relative/revalidation mechanism. If the mechanism cannot establish that the observation and operation concern the intended directory, fail closed. A marker above a mount, a pathname, configured UUID, cached mount mapping or cached marker alone is insufficient.

The initial profile must check symlinked ancestors, unexpected directory/mount substitutions and missing mounts exposing underlying directories. Do not persist volatile mount IDs or device numbers as permanent identity keys; they may only assist current observation consistency. Do not require the two roles to share a filesystem/device; when they do, their approved directory identities must still be distinct. Reobserve relevant bindings before publication, opening media, removal and persistence; check both roles before new deletion acceptance. Startup-only validation is insufficient. Reboot/container recreation must preserve acceptance of the same persistent directory identities at the same application-visible paths, despite changed ephemeral mount/device identifiers.

Every later profile must also account for its platform's reparse points, cached metadata, reconnects and stale handles; cached marker access alone never proves a remote share is reachable. The Linux format does not certify NAS or other filesystems.

The initial profile assumes operator-controlled directory ancestors, role roots and mount configuration: no untrusted process can rename/replace them, mount over them, edit markers or mutate managed media. Ordinary filesystem permissions and the deployment arrangement must enforce that assumption. While service is active, managed namespace writes are limited to coordinated provider operations; external restores, file managers and other independent writers are excluded, even if they run under a trusted account. Application code treats markers as read-only during normal service; all authorized relocation/restoration stops and fences every process capable of storage mutation and drains outstanding I/O. Identity checks alone do not defeat malicious concurrent host filesystem mutation. Privileged deliberate cloning/tampering is outside the threat boundary. A physical clone preserving filesystem UUID, directory handles and location evidence may be indistinguishable; reject conflicting duplicate identities if observed, but do not claim universal clone detection or content/snapshot integrity.

### Native feasibility gate

`linux-ext4-v1` remains a proposed initial-profile implementation until native tests demonstrate observation, persistence and replacement detection under the intended unprivileged application/deployment identity. Filesystem-UUID and file-handle acquisition must work in the actual mount/container arrangement; do not infer support from the OS name or a configured identifier. A native helper/adapter must not require unrestricted host/disk capabilities or privileged-container operation. Any new helper or dependency needs separate focused approval. If usable observation is unavailable, stop profile certification and report the limitation; there is no pathname-only, inode-only or `st_dev`-only fallback. Additional platform profiles remain staged under Option B.

### Unavailable provenance

Missing, mismatched, unsupported or uncertain binding evidence blocks media uploads/reads and new irreversible deletion acceptance with the existing sanitized `503 Service unavailable` response, preserving authentication/authorization ordering. Future destructive execution must stop issuing further destructive steps when identity cannot be confirmed and leave the journal pending; already submitted filesystem calls cannot be recalled. Missing targets on unverified storage never count as authoritative absence or completion. Authorized metadata-only operations may remain available. Responses and diagnostics must not disclose raw host paths, physical handles or private storage details; use bounded safe categories.

No ordinary operation creates missing directories, repairs markers, adopts storage or rebinds the database. M12B's blanket HTTP startup refusal remains until separately authorized M12C implementation passes provenance and HTTP gating review; a populated singleton or marker alone cannot justify removing it.

### Provisioning

Fresh initialization is an explicit operation on verified empty locations. It may create the reviewed layout and identity markers; ordinary uploads and startup may not implicitly initialize missing storage.

Fresh initialization additionally requires an empty asset population and no deletion receipts. Generate the identity tuple explicitly, observe physical evidence for both approved empty role locations, persist both exclusive version 2 markers containing that evidence, freshly verify both bindings, then insert the singleton in a short transaction. If its COMMIT is uncertain, confirm the exact committed tuple independently; until confirmed, storage remains unavailable. If marker creation is partial or conflicting, leave the database unadopted and require explicit recovery. Never overwrite markers or automatically retry initialization with new identities. The same fail-closed commit/recovery rules apply to adoption.

Existing-storage adoption requires:

- Separate maintainer authorization.
- Stopped writers/executors.
- Confirmed database/storage pairing.
- An operator-reviewed inventory/recovery manifest tying the complete existing asset population to the proposed originals and thumbnails locations. Resolve historical path syntax/roots and investigate missing or inconsistent files; filenames, absence, copied markers or matching configuration alone do not establish pairing. Do not follow stored paths outside the reviewed roots. If the evidence cannot establish one storage set, stop without inserting the anchor or accepting deletion.
- Reviewed backup and recovery plan.
- Verified physical observation, exclusive version 2 marker creation and provider-appropriate persistence.
- No automatic media movement or database-path rewrite.

Persist and verify both role markers before committing the singleton, retaining the pairing evidence in a protected operator record outside both media roots, included in the reviewed backup/recovery procedure and not writable by ordinary application operations. This record documents authorization/inventory and is not a second mandatory runtime authority. Markers, fresh physical observation and the database anchor enforce the adopted pairing afterward; they cannot automatically prove historical provenance at first adoption. Privileged deliberate cloning/tampering remains outside the application threat boundary. Existing matching records make verification repeatable; an existing different record is an error, never permission to replace it.

Tests use synthetic roots only. Implementing or testing provisioning does not authorize adoption of the development storage.

### Approved relocation

A location change is a controlled move of the same logical storage set, not a new assignment of existing assets. Require separate approval, backups and a recovery plan; stop all writers/executors and drain or fence outstanding storage I/O; verify a complete copy/manifest for each moved role; certify the destination profile and explicitly re-establish its version 2 marker with freshly observed destination physical identity and the approved application-visible location fingerprint, preserving the logical role identity; then change the configured location and verify it against the unchanged database anchor. Either role may move independently, but both must verify before operations resume.

Keep the old location offline from all executors and record the cutover. Copying an identity marker alone is insufficient. Failed/uncertain copying or cutover remains unavailable and requires operator recovery. Do not rewrite asset metadata, anchor identities or pending/completed journal targets as part of relocation. Assigning new logical identities or splitting an existing population requires a separately designed migration outside M12.

### Restoration

Before restoring a database or media snapshot:

1. Stop every API/worker process capable of storage mutation.
2. Ensure old remote operations cannot remain active; PostgreSQL claim expiry alone is insufficient.
3. Restore a reviewed database/media pair, including its `storage_binding` row and both role identities; a pre-M12 backup requires migration followed by explicit historical adoption before storage operations.
4. Reassess pending and completed receipts against the restored state.
5. Verify database-anchor/configuration/role identity agreement, recovery-manifest provenance and compatibility before resuming. Missing or conflicting pairing evidence blocks resumption; do not derive a replacement anchor from the restored directory paths.

Backups retain both markers and the protected operator pairing/recovery manifests. File-level restoration into different directories or filesystems may invalidate the recorded physical evidence; after verifying the complete matched recovery inventory, explicitly re-establish affected markers using fresh physical observation and the approved location fingerprint, without changing database logical identities or journal targets. Interrupted/uncertain restoration remains unavailable until both roles verify. Copying old markers or successfully reading their logical IDs is not restoration approval.

Never silently assign an old binding identity to unrelated replacement storage. Do not clear receipts or resume pending operations automatically. A copied marker does not establish that a restored database/media pair is consistent.

## 13. Strict completion and staged compatibility

### Completion

All of the following are mandatory:

- Correct original binding.
- Correct thumbnail binding.
- Exact targets removed or authoritatively absent.
- Required persistence operations successful on both.
- Current claim ownership.
- Committed completion record.

Unknown or unsupported durability remains pending. No namespace-only fallback is included. On a profile using directory synchronization, retries must synchronize the relevant parents even when a prior attempt already removed the leaves.

Completion is a provider-contract guarantee, not a promise of secure erasure or infallible hardware. It does not certify removal from backups, caches, open handles or unknown staging links.

### Option B minimum certification gate

M12 requires **one initial verified local storage profile**, with Linux/ext4 the recommended first candidate. Certification must include the relevant upload, open/read and strict deletion contracts. The candidate is not certified by this specification or by historical M11 tests.

If evidence supports only a narrower first profile, record its exact limits for maintainer review at M12C. That is an implementation/release gate, not a permanent product restriction. M12 cannot claim completion without at least one verified profile satisfying its destructive-operation contract.

Linux, Windows and macOS remain first-class architectural targets. Additional profiles require their own implementation or conformance evidence before being advertised as supported. Native Windows/macOS/NAS certification is **not a blanket condition for M12 completion**.

### Verification matrix

| Profile family                    | Required evidence before support is advertised                                              | Current status / M12 gate                      |
| --------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Linux local ext4                  | Native upload, read, publication, deletion, persistence and crash tests; pinned environment | Not certified; recommended first M12 candidate |
| Linux XFS/other local filesystems | Separate filesystem evidence for the same contracts                                         | Not certified; additional profile              |
| Windows 11 NTFS                   | Native Node; ACL, reparse, sharing/open-handle, publication and durability tests            | Not certified; staged additional profile       |
| macOS APFS                        | Native Node; case/path, publication and persistence tests                                   | Not certified; staged additional profile       |
| External native-filesystem drives | Relevant native profile plus unplug, reconnect and replacement                              | Not certified; additional profile              |
| FAT/exFAT                         | Publication/permission/durability assessment; safe rejection until supported                | Unverified                                     |
| SMB/NAS                           | Pinned client/server/share profile and disconnect/cache/recovery tests                      | Unverified                                     |
| NFS/NAS                           | Pinned protocol/mount/server profile and stale-handle/recovery tests                        | Unverified                                     |
| Docker/WSL/VM shared mounts       | Separate host-sharing profile                                                               | Unverified                                     |

Native certification cannot be satisfied by a Linux container running on a Windows/macOS host. Mock tests establish contract behavior, not native certification. No universal compatibility claim is made.

Known unsupported destructive capabilities prevent new deletion acceptance. A later outage leaves existing intent pending. Metadata-only operations may remain available when storage is unavailable, provided schema and authorization requirements are satisfied. Storage readiness must be reported safely without leaking paths.

Startup validates configuration and exact schema and assesses bindings without migration, marker creation or adoption. Capability-specific failures must not silently enable unsafe operations.

## 14. Failure and recovery matrix

| Event                               | Required result                                            |
| ----------------------------------- | ---------------------------------------------------------- |
| Acceptance rolls back               | Asset remains trashed; no unlink                           |
| Acceptance COMMIT uncertain         | No unlink without positive journal confirmation            |
| Crash after acceptance              | Pending receipt survives                                   |
| Claim COMMIT uncertain              | Confirm matching token before I/O                          |
| Another claim is active             | Return pending; no competing work                          |
| Claim expires during a syscall      | Overlap may occur; immutable target; stale result rejected |
| Database connection lost during I/O | No transaction held; stop further steps when detected      |
| Original removed, thumbnail fails   | Pending; retry both idempotently                           |
| Targets absent but durability fails | Pending                                                    |
| Storage disconnected/replaced       | No false absence or completion                             |
| Completion COMMIT uncertain         | Read receipt; never recreate files                         |
| Client loses response               | Status/repeated command resolves the operation             |
| Process crashes after completion    | Receipt remains completed                                  |
| Backup restores old media           | Separate recovery procedure; no automatic resumption       |

Completed receipts do not prove that backups, caches or unknown staging links were erased. M12 has no automatic liveness guarantee: pending work requires another explicit request.

## 15. M13 reuse and first-alpha gates

M13 queue messages contain operation identifiers, not trusted paths. Workers use the same:

- Journal.
- Claim protocol.
- Binding checks.
- Provider operations.
- Completion rules.

Redis loss cannot erase PostgreSQL deletion authority. Pending-journal enumeration can repair lost queue submissions. Duplicate jobs must be safe.

Automatic expiry must recheck current Trash state and approved retention eligibility before acceptance. It must not bypass the journal protocol or introduce an administrator media bypass. A system expiry policy can accept eligible deletions only under separately reviewed rules; it does not fabricate an HTTP session.

Automatic expiry and safe maintenance are required before first-alpha approval. M12 completion alone does not satisfy that gate. Future sharing obligations belong before acceptance; M13 execution does not reinterpret ownership.

## 16. Acceptance tests

### Pagination and lifecycle

- Default/boundary/invalid limits.
- Equal timestamps and sub-millisecond ordering.
- Cursor tampering, oversized inputs and collection/owner mismatch.
- No gaps/duplicates for unchanged datasets.
- Owner and NULL-owner isolation.
- Current, missing, malformed and stale ETags.
- Same-state no-ops and version overflow safety.
- Deterministic Trash/Restore/delete races.
- Byte-identical media after Trash/Restore.
- Active-route denial while trashed.
- Owner-only Trash thumbnail access.
- Bounded results and representative query/index behavior.

### Authentication and HTTP

- Anonymous, restricted, ordinary owner, foreign user and administrator.
- Missing/null/wrong Origin and malformed CSRF.
- HEAD, Range, unknown paths and static/UUID route precedence.
- Session expiry, logout-all, password change and disabling races.
- Sanitized parser, storage and database failures.
- Successful original/thumbnail streaming regressions.
- Repeated acceptance, receipt discovery, explicit retry and completed no-op behavior.

### Claims and crashes

- Two concurrent claimants.
- Claim expiry and renewal without timing-dependent sleeps.
- Uncertain acceptance and claim commits.
- Pause one attempt inside removal, expire/reclaim, complete another, resume the first.
- Stale error/completion cannot overwrite current state.
- Database disconnection during filesystem work.
- No checked-out transaction/connection while I/O is blocked.
- HTTP cancellation retains active I/O accounting.
- Process termination after acceptance, first removal, both removals and before completion.
- Lost completion acknowledgement.
- Explicit retry after restart.
- No scheduler, automatic restart sweep or detached retry.

### Storage and upload portability

Run the provider contract suite on the initial M12 local profile. Reuse it natively for each additional Linux, Windows or macOS profile before advertising that profile:

- Exact original bytes.
- Invalid/truncated upload handling.
- Exclusive staging and publication collisions.
- No overwrite fallback.
- Publication uncertainty.
- Platform permissions.
- Symlink/junction/reparse/path attacks as applicable.
- Open-stream deletion behavior.
- Historical path syntax.
- Full disk, permission, unlink and persistence failures.
- Role-specific missing/replaced bindings, missing mounts exposing underlying directories and replacement filesystems at unchanged paths.
- Copied markers in different directories, including directories on the same filesystem: physical mismatch rejects access/acceptance; no file removal or journal insertion.
- Marker-v2 strict parsing: size boundary, invalid UTF-8/BOM, duplicate/unknown/missing fields, unsupported format/profile/handle type, malformed UUID/hex/fingerprint and version 1 evidence. No coercion, truncation, implicit upgrade or repair.
- Deterministic location-fingerprint vectors covering lexical aliases, different absolute paths, Unicode encoding, invalid path input and symlinked ancestors.
- Native filesystem-UUID and opaque-handle observation under the intended unprivileged deployment identity; denied/unavailable observation fails closed with no fallback.
- Identity replacement/inconsistency between preflight and individual publication/open/removal/persistence operations; stop new unsafe work and never report unverified absence/completion.
- Reboot and container recreation on the native certified profile: same persistent identities/locations remain valid despite changed ephemeral identifiers; changed physical storage fails.
- Record the limits of undetectable physical clones and hostile privileged modification; synthetic identity equality is not proof of historical pairing or content integrity.
- Changed configuration roots pointing to an unrelated but otherwise valid adopted set: reject upload/media access and deletion acceptance without file removal or journal insertion.
- Swapped originals/thumbnail mounts, only one role replaced, incorrect database/media pairing, copied markers and unadopted identity: reject unless the explicit pairing procedure has established trusted provenance; markers alone must not bypass it.
- Synthetic adoption with ambiguous/mixed historical roots, partial marker creation and uncertain singleton COMMIT: remain unavailable until exact pairing/commit confirmation; never auto-rebind.
- Approved synthetic relocation preserving logical identities and receipts while re-establishing physical evidence, failed/interrupted copy or cutover, matched restoration into changed directories, incomplete restoration and pre-M12 restoration requiring adoption. No automatic resumption or marker repair.
- Acceptance copies the verified database tuple, not changed environment values; retries reject anchor/journal mismatch without changing either record.
- No unrelated file changes.
- Retired-ID collision cannot create a new committed asset, including delayed/concurrent upload finalization.
- Safe rejection of unsupported capabilities.

Initial Linux/ext4 certification requires a separately authorized disposable native ext4 environment (preferably an isolated Linux VM with disposable virtual disks), including independent role mounts and the intended unprivileged runtime/container arrangement. Never use `/boot` or development media as fixtures. Synthetic tmpfs/btrfs tests cannot certify ext4; process kills do not prove power-loss durability, and abrupt VM termination only establishes recovery under the recorded virtualization/cache assumptions. Do not create/mount filesystems or provision a VM without separate authorization. Missing native evidence blocks the profile's certification claim and must never be worked around by weakening identity checks.

External/NAS certification additionally requires isolated disposable mount/export tests for disconnects, stale/cached metadata, replacement storage and ambiguous outcomes. Mocking an error code is not NAS certification. These additional native/mount profiles are staged support gates, not all mandatory M12 completion gates under Option B.

### Database migrations

- Fresh installation.
- M11 upgrade.
- Explicit legacy-baseline upgrade.
- Repeated/concurrent execution.
- Partial/incompatible rejection.
- Exact journal constraints and indexes.
- Exact singleton schema, at-most-one-row enforcement, distinct role identities, empty/unadopted state after migration and preservation of an adopted record on repeated migration.
- Historical data and migration-ledger preservation.
- NULL-owner quarantine.
- Old-schema readiness rejection and unchanged historical validators.
- No startup migration.

### Verification evidence

From `server/`, run applicable `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:e2e`, `npm run test:integration`, `npm run test:migrations` and `npm run test:runtime-smoke`, plus focused formatting, Markdown-link and whitespace checks.

Use only the verified disposable PostgreSQL runner, never direct integration Vitest against an unverified target. Filesystem and crash tests use isolated synthetic directories and child processes. Report disposable-resource cleanup.

Record platform, filesystem, provider and test configuration. Mark unavailable checks **NOT RUN**. Process-kill tests do not establish power-loss durability. Historical M11 counts are not M12 results. No CI success is claimed without actual evidence. Passing mocks do not certify unsupported native platforms.

## 17. Reviewable implementation sequence

| Phase                                    | Scope                                                                                                                           | Required gate                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **M12B**                                 | Schema, journal, history-aware validation and database-only claim primitives                                                    | Historical preservation and concurrency review                                                        |
| **M12C — Storage compatibility package** | Portable provider contract, M11 upload/read adaptation, binding/adoption support and certification of the initial local profile | Separate portability review; initial profile verified; staged additional-profile limitations recorded |
| **M12D**                                 | Pagination, lifecycle versions, Trash/Restore and Trash thumbnails                                                              | Ownership, stale-command and non-destructive regression review                                        |
| **M12E.1**                               | Committed-deletion executor, claims, fault injection and crash tests                                                            | Independent destructive-core review; no permanent-delete HTTP activation                              |
| **M12E.2**                               | Acceptance/status/retry HTTP integration and operational documentation                                                          | Enable destructive routes only after E.1 and relevant storage certification pass                      |
| **M12F**                                 | Full regression, independent security review and readiness report                                                               | Maintainer review before checkpoint/PR                                                                |

This explicitly introduces storage compatibility as its own work package. It is not hidden inside pagination or deletion implementation. M12E.1 must complete deletion-specific conformance evidence for the initial profile before M12E.2 exposes destructive APIs; M12C approval alone does not certify an executor that has not been implemented.

Option B keeps additional native Windows/macOS/external/NAS certification staged. Any such implementation beyond the approved initial package needs its own bounded authorization before work begins. Lack of that later certification must remain visible, not be represented as universal support or as an automatic M12 blocker.

Likely code areas:

- Database types, new migration/inspector, provider/runner/readiness.
- Asset repository/service/controller and DTOs.
- Dedicated deletion repository/service/executor.
- Storage provider contract, applicable platform adapter and identity handling.
- Focused runtime configuration and safe-error handling.
- Unit, HTTP, PostgreSQL, process-crash and provider conformance tests.
- OpenAPI, operator guidance and milestone reports.

Any native dependency or helper needed for a profile's guarantees requires a focused justification and approval. Do not silently weaken a capability to avoid that review.

Each phase stops for review. Approval of this specification does not authorize M12B implementation; that requires separate maintainer authorization. M12E is unrelated to the deferred M11E legacy-ownership mapping work.

## 18. Roadmap adjustment for separate approval

The current roadmap places Docker deployment before Redis/BullMQ. Propose:

1. M12 — Manual Asset Lifecycle.
2. M13 — Background Jobs and Maintenance.
3. Deployment and first-alpha validation afterward.

Exact later numbering remains a roadmap decision. Automatic expiry, safe maintenance, production TLS/proxy validation, backup/restore rehearsal and other alpha gates remain required.

The [existing roadmap](../roadmap.md) is not changed by this documentation task. M12 completion does not authorize deployment or a merge into `main`.

## 19. Remaining decisions and future policies

The architecture direction, separate journal, claims, strict completion, M12/M13 division and Option B staged certification are settled direction for this draft; do not reopen them without a concrete contradiction or safety issue.

The following remain open for later scoped approval:

1. **Initial verified profile:** Linux/ext4 is the recommended candidate. Record the actual provider/runtime/filesystem limits and evidence at the implementation gate; no certification is claimed now.
2. **Additional profiles and native helpers:** authorize and verify them separately before advertising support. They are not a blanket M12 completion prerequisite.
3. **Receipt retention after M12:** M12 retains all receipts. Later purging requires identifier-safety, privacy and mobile-sync decisions.
4. **Future retention/sharing policy:** M13's 30-day expiry remains provisional; Family Space preservation obligations and mobile synchronization semantics are not selected here.
5. **Roadmap numbering and deployment order:** approve the proposed adjustment separately.

This approved specification and ADR do not authorize M12B implementation, a real-data upgrade, existing-storage adoption, deployment, commit, push, PR, merge or other changes to production or the `main` branch. Do not begin M12B without separate authorization.
