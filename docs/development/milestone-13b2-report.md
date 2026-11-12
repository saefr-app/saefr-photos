# Milestone 13B.2 — Independent recovery permit

- **Status:** Independent review returned FAIL for H1. Focused H1/L1/L2 corrections and fresh verification are complete; awaiting independent re-review, not self-approved. Unstaged and uncommitted.
- **Branch:** `codex/m13b2-recovery-permit`.
- **Base:** merged `integration` at `87782bf8af61b88760b9504d7d4ecf19238477a8`.
- **Date:** 2026-10-29.
- **Authority:** Maintainer's explicit M13B.2 implementation authorization and approved M13 v3 contract, SHA-256 `28bc50d8691a1a5524a772ddd66f7611785db513dd0d6b578e3bbf8d0b3ccee1`, reverified locally. The approved v3 document is present in the original checkout as an untracked planning document; its historical proposal wording is not silently rewritten. B.1 is merged; its historical report is preserved.

## Implementation and decisions

The permit is an independently persisted, operator-owned file, outside declared database/media restore sets. The runtime reader rejects the operator/root UID, effective capabilities, writable namespaces, symlinks, non-regular/multiply-linked records and incorrect ownership/modes. Canonical bounded version-1 JSON has a Boolean armed flag, positive PostgreSQL-bigint-compatible generation string and domain-separated pairing fingerprint. Missing/invalid records never initialize themselves.

Each observation reads the protected permit, verifies exact M13 migration history/schema and both existing storage-role identities, compares retained database generation history, and rereads the permit. Results contain only `allowed`/generation or a bounded rejection code. No authorization token, executor callback, queue handler, checkpoint writer or reservation is introduced. Production worker composition is unchanged and remains synthetic.

The local operator CLI supports initialize (disarmed), status, disarm and arm. Initialization/arm require a terminal and a separately prepared protected, digest-bound approval attestation referring to fencing, reconciliation and backup evidence for the exact action/generation/pairing. This is an explicit human trust boundary, not automated proof of quiescence. Disarm/status require no database/media connection. Dedicated `RECOVERY_PERMIT_*` settings do not read `.env` or fall back to application credentials. The inspection connection is read-only, bounded and separately closed.

Updates use an exclusive persisted lock, same-directory temporary file, file sync, exclusive initialization/atomic update, directory sync and readback. Uncertain publication retains a blocker; uncertain lock release attempts to restore it. External process fencing remains mandatory after any failed command, including when filesystem failures prevent blocker recovery. There is no automatic unlock, repair, reset, generation wrap, rebinding or rearm. Recovery of a stranded lock is deliberately an operator-reviewed procedure.

Conservative implementation details selected under the authorization: canonical key order/newline; 1024-byte permit and 4096-byte attestation bounds; maximum generation `9223372036854775807`; parent `0750`, record `0640`, evidence `0600`; explicit restore-root inventory; initial Linux descriptor-relative implementation; current M13 schema version in pairing; protected evidence digests plus interactive command. These choices introduce no database columns or dependencies. See the complete [operator and restore contract](recovery-permit.md).

## Exact file scope

| File                                                | Change                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `server/package.json`                               | Add explicit `recovery:permit` operator command.                                             |
| `server/src/worker/recovery-permit.ts`              | Canonical format, generation, fingerprint and attestation contracts; typed sanitized errors. |
| `server/src/worker/recovery-permit-store.ts`        | Protected reads, OS authority checks and serialized durable updates.                         |
| `server/src/worker/recovery-permit.service.ts`      | Read-only live pairing probe, fresh decisions and operator orchestration.                    |
| `server/src/worker/recovery-permit-config.ts`       | Strict dedicated configuration and CLI parsing; read-only inspection pool.                   |
| `server/src/worker/recovery-permit-operator-cli.ts` | Explicit local commands with sanitized output.                                               |
| `server/src/worker/recovery-permit.spec.ts`         | Format/configuration, stale observations, failure and restart tests.                         |
| `server/src/worker/recovery-permit-store.spec.ts`   | Real temporary filesystem plus deterministic injected update failures.                       |
| `server/test/recovery-permit.integration-spec.ts`   | Disposable PostgreSQL schema/pairing/history, process and permission tests.                  |
| `docs/development/recovery-permit.md`               | Operator workflow, controlled restoration, failure recovery and limitations.                 |
| `docs/development/milestone-13b2-report.md`         | This implementation and verification record.                                                 |

No migrations, historical inspectors/reports/ADRs, authentication, asset/storage implementation, existing worker composition, CI workflows, dependencies or lockfile are changed.

## Initial implementation verification (before review corrections)

All commands ran inside `server/` in the isolated worktree, using existing installed dependencies and Node.js 24.22.0. No application environment file or real operator target was used.

| Command / check                  | Actual result                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `npm run build`                  | Passed, including native helper build.                                                                    |
| `npm run typecheck`              | Passed.                                                                                                   |
| `npm run lint`                   | Passed without warnings after corrections.                                                                |
| `npm run test`                   | **202 passed**, 24 files. Includes 43 new permit unit cases.                                              |
| `npm run test:e2e`               | **60 passed**, 8 files. Existing HTTP behavior remains unchanged.                                         |
| `npm run test:integration`       | Final run: **309 passed, 6 skipped**, 16 passed files and one skipped file. Includes 12 new permit cases. |
| `npm run test:migrations`        | **106 passed**, one file. These cases overlap the full PostgreSQL suite.                                  |
| `npm run test:redis`             | **17 passed**, one file. Production worker remains synthetic.                                             |
| `npm run test:runtime-smoke`     | Passed: invalid configuration and unavailable authentication database produced safe nonzero exits.        |
| Focused Prettier                 | Passed for all 11 changed/new files.                                                                      |
| Relative Markdown links          | Passed for both new documents.                                                                            |
| Tracked/untracked Git whitespace | Passed; index remains empty.                                                                              |

The final PostgreSQL integration container `saefr-m7-test-e1a10420a451`, migration container `saefr-m7-test-b0780db7d9a2` and Redis container `saefr-m13a-redis-db7f316dfea6` were removed by their runners. The earlier integration containers were also removed, including the failed run. Final label-filtered container inventories were empty.

Six existing native-storage HTTP cases were skipped by the standard runner; no fresh native-ext4 or hosted CI success is claimed. No required command remained unrun. The reported E2E run preceded the later isolated permit parser corrections; the production HTTP composition does not import the permit subsystem. Full unit, PostgreSQL, migrations, Redis and smoke verification passed after those corrections.

Coverage added:

- Duplicate/extra/malformed/oversized JSON, invalid UTF-8, wrong field types (including array coercion), generation precision and overflow.
- Symlinks/hard links, unsafe permissions/ancestors, wrong authority, runtime write denial, stale generations and serialized writers.
- Temporary-file sync failure, rename followed by lost acknowledgement, directory persistence failure and failed lock-release persistence.
- Exact real PostgreSQL schema/history mismatch; both independently observed role mismatches; unavailable database/media; persisted generation lower bound.
- Pending journal, blocked retry and retained clearance fixture plus reconciliation singleton remain byte-equivalent through read/deny/restart/disarm checks. The inspection pool proves `transaction_read_only=on`.
- A child process is killed at a controlled pre-publication lock boundary; a new service instance refuses the leftover blocker. This is process interruption, not a power-loss test.
- Real CLI status/disarm with no DB settings; noninteractive arm rejection with fixed sanitized output.
- Actual distinct Linux UIDs in the verified disposable PostgreSQL container can read an operator-owned fixture but cannot overwrite it, add a sibling or rename it. This checks OS DAC. Positive service tests deliberately substitute the operator reader and synthetic physical observer; they do not claim a complete deployed multi-UID/native-ext4 permit flow.

Implementation iterations: the first new-test typecheck rejected a duplicate fixture property; it was corrected. Lint initially flagged intentional control-character matching and then string spreading; explicit code-unit checks removed both warnings. Self-review found coercion of an array-shaped fingerprint in the format parser; strict string validation and a regression were added. The pairing comparison already denied that malformed value; the parser now rejects it at the boundary. A file-write command initially used the wrong relative path and made no edit; it was corrected. The first expanded CLI integration run had 308 passes, one failure and six skips: the flag-name parser incorrectly rejected digits in `--approval-sha256`. It was corrected and a positive command-parsing assertion was added before rerunning verification. The failed command had not opened a database connection or modified a permit. No failed verification is represented as passed.

## Initial self-review, safety and remaining gates

Reviewed format/authority boundaries, descriptor path handling, publication/crash ordering, stale generations, identity checks, output sanitization and production import scope. New code does not mutate PostgreSQL: only test fixture setup uses SQL writes, inside the owned disposable runner. Historical migrations and all production deletion paths remain unchanged. No automatic handler imports this subsystem.

The original checkout, development PostgreSQL, real media, storage markers and persistent Docker volumes are untouched. Test files and permit/evidence artifacts are synthetic temporary fixtures. Container ownership, credentials, tmpfs, loopback and cleanup are established by the existing runner before database fixture SQL; Linux UID tests use that same verified disposable container. All changes remain unstaged, HEAD unchanged.

Limitations and required follow-ups:

1. External process fencing and reviewed reconciliation are indispensable. Evidence hashes bind an operator attestation but cannot establish that a human actually completed those tasks. B.2 does not clear blocked execution state or grant takeover.
2. A database/media clone with matching identities cannot be distinguished by the fingerprint. Permit restoration/rollback, omitted restore sets, mount aliases and privileged malicious operators are outside the controlled-restore guarantee. Verify independent persistence and whole-directory runtime mounts during deployment.
3. Linux permission checks and synthetic filesystem faults are tested; fresh hosted native-ext4 certification, actual power-loss durability, supported storage recovery rehearsal, deployment permissions and multi-host operator fencing are **not verified** here. Windows/macOS/NAS permit backends are not implemented.
4. No atomic transaction spans PostgreSQL, the external permit and filesystem calls. Already-issued calls are not cancelled. Unknown update results require continued external fencing and reviewed recovery; if a blocker cannot be persisted, do not resume based on the visible permit alone.
5. A missing/malformed permit, stranded lock or exhausted generation requires manual reviewed recovery; there is no automatic repair or reset. An armed permit must never be restored alongside the database.
6. Future B.3/B.4 must perform fresh gate/generation checks, enforce durable attempt/clearance protocols and never treat this observation as an execution capability. The retained-history maximum query is an additional diagnostic lower bound; assess its cost at scale before high-frequency worker integration.
7. Existing B.1 dependency-audit observations (2 low, 4 moderate at that checkpoint) were not re-audited or fixed here. No new dependency is introduced. Hosted CI is not claimed for uncommitted changes.

Next gate: independent source/security review of B.2 only. No checkpoint, production permit operation, B.3 reconciliation or B.4 automatic deletion is authorized by this report.

## Independent-review corrections and fresh verification

The reviewed original artifact was `/tmp/saefr-m13b2-review.patch`, 104,141 bytes, SHA-256 `d33ff17d3d483b337cf723fe80a0682f161e9d1daab5ea376f6980bac5556764`. Its independent verdict was **FAIL**, with one HIGH finding and two LOW coverage findings. This corrective implementation does not supersede that verdict with independent approval.

### H1 — Restore-root exclusion

The original `posix.normalize()` check accepted `/synthetic/media/`, but the prefix comparison appended another separator and tested `/synthetic/media//`. A permit beneath `/synthetic/media/control/` could therefore pass an explicitly declared exclusion. The same shared directory validator applied to approval records.

The correction normalizes only trailing directory separators, then uses `posix.relative()` with explicit exact-match, parent-component and absolute-result checks. `/media`, `/media/` and `/media//` now exclude the same locations. Dot segments and repeated internal separators remain rejected rather than resolved through potentially symlinked paths. Target filenames cannot end in `/`. The dedicated configuration and storage-root membership check use the same directory normalization. Existing descriptor-relative opens, no-follow flags, identity/ownership/mode checks and publication protocol are unchanged.

Sixteen added unit cases cover configuration normalization and real temporary-file reads through production `readOperator()` and `readApproval()`: the original trailing-slash bypass, repeated trailing separators, dot segments, nested roots, exact filename equality, `/`, sibling-prefix paths, and noncanonical target paths. Positive controls read otherwise valid records outside excluded roots. The original bypass spelling now returns `permit_untrusted` for a permit and `approval_invalid` for approval data. Dot-segment roots also fail closed. The operator guide clarifies these lexical rules without claiming that they detect mount aliases or replace physical restore-set exclusion.

### L2 — Symlink-ancestor precision

The target directory now contains a valid permit. Reading its direct path succeeds; accessing that same record through a symlink ancestor must return `permit_unavailable`. This would fail if the reader followed that symlink: the target is readable and no longer missing. The assertion no longer accepts an arbitrary error.

### L1 — Actual separate-UID runtime reader

The existing disposable PostgreSQL test now executes the built production `RecoveryPermitStore.readRuntime()` under UID/GID `65534:65534`, with a root-owned synthetic control directory and record. It copies the existing Node executable, the two built permit modules, their migration-module imports and the installed pure-JavaScript Kysely package into a random directory inside the already ownership-verified test container. Importing these modules does not execute migrations. No new image, dependency installation, host mount, host UID change or host permission modification is required.

The actual reader successfully reads generation 7, observes the operator's atomic replacement at armed generation 8, and observes disarmed generation 9. Shell mutation attempts and the actual store updater are denied under the runtime UID. Incorrect file ownership and group-write permissions return `permit_untrusted`; restoring valid fixture permissions allows reading again. Container identity is revalidated before targeted fixture cleanup, including on assertion failure. This case executed successfully and was not skipped. The PostgreSQL service-policy tests still use their documented operator-reader/synthetic-observer substitution; the new test separately closes the actual runtime-reader gap, without claiming a complete native-storage deployment rehearsal.

The fixture requires a Linux Node executable compatible with the disposable Linux container's architecture/libraries, as on this host and the intended Ubuntu CI profile. An incompatible runtime fails the test explicitly; there is no silent skip or fallback to a mock. No fresh hosted CI run was performed here.

### Fresh corrective verification

All commands ran from `server/` using the existing Node.js 24.22.0 installation. Resource-heavy suites ran sequentially.

| Command/check                                                                                                | Actual result                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `./node_modules/.bin/vitest run src/worker/recovery-permit.spec.ts src/worker/recovery-permit-store.spec.ts` | **59 passed**, 2 files; includes the 16 new regression cases.                                                                    |
| `npm run build`                                                                                              | Passed, including native helper compilation.                                                                                     |
| `npm run typecheck`                                                                                          | Passed.                                                                                                                          |
| `npm run lint`                                                                                               | Passed.                                                                                                                          |
| `npm run test`                                                                                               | **218 passed**, 24 files.                                                                                                        |
| `npm run test:e2e`                                                                                           | **60 passed**, 8 files.                                                                                                          |
| `npm run test:integration`                                                                                   | **309 passed, 6 skipped**; 16 passed files and 1 skipped native-storage file. Actual separate-UID production-reader test passed. |
| `npm run test:migrations`                                                                                    | **106 passed**, 1 file; included in the 309 PostgreSQL cases, not additional unique tests.                                       |
| `npm run test:redis`                                                                                         | **17 passed**, 1 file.                                                                                                           |
| `npm run test:runtime-smoke`                                                                                 | Passed: invalid configuration and unavailable authentication DB caused safe nonzero exits.                                       |
| Focused Prettier, relative Markdown links and tracked/untracked whitespace                                   | Passed after the final documentation update.                                                                                     |

The 59 focused cases are included in the 218 unit cases. The standard native-storage skip policy is unchanged. No required check was omitted. An initial formatting/test invocation was blocked by the sandbox's read-only worktree access (`EROFS`) before any test ran; the commands were rerun successfully with worktree access. No correction introduced a test assertion, build, typecheck or lint failure.

Owned containers removed by their runners: PostgreSQL `saefr-m7-test-654f57e54a50`, migration-only PostgreSQL `saefr-m7-test-3f092eae0d41`, and Redis `saefr-m13a-redis-713db2de62f7`. Final purpose-label inventories were empty.

### Corrective scope and remaining review gates

The original 11-file manifest above is unchanged. This pass changed only seven of those files: `recovery-permit-store.ts`, `recovery-permit-config.ts`, both permit unit-test files, `recovery-permit.integration-spec.ts`, this report and the operator guide. The other four reviewed files are unchanged. HEAD remains `87782bf8af61b88760b9504d7d4ecf19238477a8`, branch `codex/m13b2-recovery-permit`, index empty. The complete updated patch is `/tmp/saefr-m13b2-review-corrections.patch`; forward/reverse check-only applicability and artifact identity are included in the handoff. The original patch is retained unchanged.

No migrations, production worker composition, automatic deletion, B.3/B.4 behavior, real database, real storage markers, media or persistent volumes were changed. Historical contract files and original checkout remain untouched. Production job handlers remain synthetic.

Live multi-process writer contention and adversarial ancestor replacement during asynchronous operations remain additional coverage gaps. Process interruption/injected synchronization failures are not power-loss certification. Physical backup-set independence, trusted operator evidence, external fencing, native filesystem durability and supported restore rehearsal remain required operational gates. All initial security limitations above remain applicable. The patch is prepared for focused independent re-review; no staging, checkpoint, push or PR is authorized by this report.
