# Independent automatic-recovery permit — M13B.2

## Scope and authority

This subsystem implements the externally controlled gate approved for M13B.2. It is **not connected to the production worker**, whose handlers remain synthetic. It does not enqueue, reserve, reconcile, clear an execution block, or invoke the M12 deletion executor. [B.1](milestone-13b1-report.md) remains the database schema contract. [B.2 report](milestone-13b2-report.md) records verification and limitations.

A permit is additional approval for future **automatic** recovery. PostgreSQL's committed M12 journal and verified immutable storage targets remain deletion authority. The permit does not alter explicit authenticated M12 owner retry behavior. Future B.3/B.4 integrations require separate review; an `allowed` result is an observation, never a reusable execution token. Recheck on startup/reconnect, before reservation/dispatch, and before each new irreversible provider action, including the expected permit generation. Already-issued filesystem calls cannot be retracted by disarming.

## Controlled deployment and filesystem contract

The initial implementation supports Linux with `/proc/self/fd`, trusted POSIX ownership, no-follow opens, same-directory atomic rename/link, file sync and directory sync. It is not Windows/macOS or NAS certification. Deployment must establish that the external control filesystem implements these operations durably. Process-kill and injected failures do not prove power-loss durability.

Use an operator UID different from the runtime UID. Root may be the operator; root or a process with effective capabilities cannot be the runtime reader. The dedicated permit parent must be owned by the operator UID, have the configured reader GID, and have mode `0750`. Permit records are `0640`, regular, single-link files. Approval attestations are `0600` with the same UID/GID. Ancestors must be owned by root or the operator and not group/other writable; root-owned sticky intermediate directories are supported for isolated fixtures, not as the final parent. No symlink components or hard-linked records are accepted. Effective runtime write access to non-sticky ancestors, the parent or record is rejected, including an ACL that grants writing. Deployments must also exclude privilege escalation, shared operator identity, container control and untrusted mount administration for the runtime account.

The operator pre-provisions the directory. Commands never create directories, repair permissions or markers, adopt storage, or initialize missing records implicitly. Runtime configuration must be operator-controlled: do not let the worker choose a different trusted UID, namespace or permit location. Mount the entire control directory read-only into runtime containers; mounting only an individual file can pin a superseded inode across atomic replacements and is unsupported. The operator and all readers must see the same directory and updates, without stale network caches.

The permit must be outside **all** database/media backup and restore sets, including independently mounted role roots and storage markers. Explicit lexical exclusion roots are checked by path components, for both permit and approval files. Trailing directory separators are equivalent (`/media`, `/media/` and `/media//`); dot segments and noncanonical internal separators remain rejected. Exact root matches and descendants are excluded, including every target when `/` is excluded; sibling names such as `/media-other` are not descendants of `/media`. Target filenames cannot end in a separator. This check cannot discover bind-mount aliases, snapshot policies, block-device clones or omitted restore sets. An operator must verify physical exclusion and keep the external control directory independent when defining the deployment and restore procedure. No automatic fingerprint can distinguish an exact clone or prove that a restoration has not occurred.

## Record format and pairing

Exactly this key order, compact UTF-8 JSON, with one trailing newline:

```text
{"version":1,"armed":false,"generation":"1","pairing_sha256":"<64 lowercase hexadecimal characters>"}
```

The illustrative placeholder is not a valid record. Maximum size is 1024 bytes. Duplicate/extra keys, reordered fields, whitespace variations, BOM, invalid UTF-8 and noncanonical values are rejected. Generations are positive decimal strings up to `9223372036854775807`, avoiding JavaScript number rounding. Initialization is generation 1 and disarmed. Every successful arm/disarm advances once; callers supply the exact expected previous generation. There is no reset/rollback command. Exhaustion requires remaining fenced and a separately reviewed procedure, not wrapping or silently reinitializing.

Pairing is SHA-256 of UTF-8 `saefr-automatic-recovery-pairing-v1`, one NUL byte, then compact JSON of this ordered array:

```text
["202610290001_maintenance_recovery", storage_id,
 originals_binding_id, thumbnails_binding_id, storage_layout_version]
```

Schema validation is independent of the fingerprint: each authorization inspects exact M13 migration history/catalogs and invokes the existing storage-binding verifier for both roles, twice around the generation-history read. Observed physical identities must match their markers, role, logical binding and configured location. No permit read caches pairing. The largest retained permit generation in retry/clearance rows is an additional lower bound; restored database history is **not** an independent rollback detector. Restoring the permit itself from an old backup is forbidden.

## Configuration and commands

All settings below are explicit `RECOVERY_PERMIT_` variables. No `.env` loading, application `POSTGRES_*` fallback or default operator target exists.

| Suffix                                                                                    | Meaning                                                                                               |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `PATH`                                                                                    | Canonical absolute permit filename.                                                                   |
| `OPERATOR_UID` / `READER_GID`                                                             | Decimal POSIX identities established by deployment.                                                   |
| `RESTORE_ROOTS`                                                                           | JSON array of canonical absolute excluded backup/media/restore roots; include all independent mounts. |
| `STORAGE_ROOT`                                                                            | Media root; must also appear in `RESTORE_ROOTS`. Arm/init only.                                       |
| `STORAGE_ID` / `ORIGINALS_BINDING_ID` / `THUMBNAILS_BINDING_ID`                           | Expected existing storage-binding tuple. Arm/init only.                                               |
| `POSTGRES_HOST` / `POSTGRES_PORT` / `POSTGRES_DB` / `POSTGRES_USER` / `POSTGRES_PASSWORD` | Explicit inspection connection; use a dedicated catalog/data reader. Arm/init only.                   |

The pairing connection has `default_transaction_read_only=on`, a single pooled connection, bounded connect/statement/lock timeouts and sanitized idle errors. It does not run migrations or API startup. Status and disarm need only the first three location settings, even when PostgreSQL and media are unavailable.

From `server/`, after a trusted build, the CLI shapes are:

```text
node dist/worker/recovery-permit-operator-cli.js status --confirm-permit=<absolute-permit-path>
node dist/worker/recovery-permit-operator-cli.js disarm --confirm-permit=<absolute-permit-path> --expected-generation=<current>
node dist/worker/recovery-permit-operator-cli.js initialize --confirm-permit=<absolute-permit-path> --expected-generation=0 --approval=<absolute-evidence-file> --approval-sha256=<digest>
node dist/worker/recovery-permit-operator-cli.js arm --confirm-permit=<absolute-permit-path> --expected-generation=<current> --approval=<absolute-evidence-file> --approval-sha256=<digest>
```

`npm run recovery:permit -- <action> ...` builds then invokes that CLI. Arm/init require an interactive terminal and a protected attestation, not merely `--confirm-permit`. Unknown/duplicate flags fail. Outputs expose only armed state/generation or bounded error codes; never database credentials, configured paths or raw exceptions. These examples are **not authorization** to use any command against development data or actual storage.

## Operator evidence and restore procedure

An approval file is compact UTF-8 JSON in this exact key order with a trailing newline (maximum 4096 bytes):

```text
{"version":1,"action":"arm","expected_generation":"<current>","pairing_sha256":"<digest>","operator_reference":"<review-id>","fencing_record_sha256":"<digest>","reconciliation_record_sha256":"<digest>","backup_record_sha256":"<digest>","first_provisioning":false}
```

References are lowercase SHA-256 values; operator reference is 1–128 ASCII letters, digits, dot, underscore or hyphen. For initialization use action `initialize`, expected `0`, and `first_provisioning:true`. An independently reviewed exact file digest is passed on the command line. The command verifies canonical bytes, ownership/mode, action/generation/pairing and unchanged evidence across live verification. It rejects initialization when retained database permit history exists.

These hashes bind an operator's reviewed records; the CLI does **not** inspect their documents, authenticate another approver, or prove that the statements are true. The OS operator is trusted and must actually complete the procedure. Fabricated records, malicious privileged operators and unsupported restoration are outside this mechanism's guarantees. No automatic evidence generator is supplied.

Controlled restoration:

1. Fence **all** processes capable of media/database writes, including API/manual retries, workers and independent tools. Prevent their restart. Resolve outstanding syscalls or fence the old host/mount; process exit alone is not proof that a remote filesystem stopped processing a request.
2. While the external permit is still independently accessible, disarm with its exact generation. Verify success and retain the new external generation. Never restore an armed permit alongside the DB/media snapshot. If the permit is missing, malformed or locked, keep everything externally fenced; there is no bypass/init-as-repair.
3. Perform only separately approved backups/restore operations. Establish correct database/media pairing with existing storage procedures. Reconcile pending receipts, partial file removals and uncertain automatic attempts while automatic execution remains blocked. B.2 does not perform this work, create takeover clearances or release execution blocks.
4. Prepare reviewed fencing, reconciliation and backup evidence for the exact current generation/pairing. Retain it independently. After the operator resolves all relevant uncertainty, a separate authorized arm checks exact schema and both storage roles and advances the generation. Changing logical binding requires a separately reviewed protocol; this CLI refuses rebinding.
5. Verify the new record before releasing external fences. Future workers must revalidate freshly; startup/reconnect never rearm. An ordinary restart with no restore can use an unchanged armed permit only after fresh checks. Restarts and restores are not interchangeable.

## Serialization, interruptions and uncertain outcomes

One exclusive `.recovery-permit.lock` serializes all writers in the parent directory and blocks readers. It is persisted before publication. A temporary record is written, synced, published exclusively for initialization or atomically renamed for update, then the parent is synced and the exact bytes/namespace rechecked. Only then is the lock removed and its removal synced. No wall-clock lock expiry or automatic takeover exists.

Before publication starts, normal failure can remove the command's own temporary file and lock. After publication starts, an unknown outcome retains the lock. A failed lock-release acknowledgement attempts to recreate and sync a blocker. If storage fails so severely that this recreation fails, **external fencing must continue**: the command reports failure and does not authorize resumption. The new permit was already persisted before lock release, but atomic coordination between an external file, process fencing and PostgreSQL cannot be claimed. A reader may have observed the confirmed record before a later unlock error; this is another reason updates require process fencing.

After any interrupted/failed update, keep processes fenced and investigate the control filesystem, current canonical record, old/new generation and evidence. A leftover lock or temporary file is retained evidence, not garbage for automatic cleanup. B.2 deliberately has no unlock/repair/reset command. Operator-mediated recovery must determine persistence and quiescence, preserve monotonicity, disarm safely, and obtain separate review before removing a blocker or rearming. Do not retry with a guessed generation or erase the directory.

## Remaining boundaries

B.2 does not prove power-loss safety, prevent a malicious OS administrator from forging authority, certify backup tools or network filesystems, stop already-issued calls, or provide cross-system atomicity. B.3 must enforce reservation/generation ordering and finite reconciliation; B.4 must recheck this gate at every required boundary and preserve the conservative execution-takeover protocol. Release readiness requires independent review, supported deployment permission/mount checks, controlled restore rehearsal and applicable native durability verification.
