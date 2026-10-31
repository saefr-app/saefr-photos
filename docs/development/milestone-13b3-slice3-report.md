# Milestone 13B.3 — Slice 3: permit integration and Redis delivery recovery

- **Status:** Implemented and locally verified. Unstaged and uncommitted, awaiting independent review; not self-approved.
- **Branch/base:** `feat/m13b3-runtime-reconciliation` at `8ef39c835fa0c18a31cfe63a6ae63b645427f201`.
- **Date:** 2026-10-30.
- **Authority:** Explicit Slice 3 authorization and the approved M13 v3 contract, reverified SHA-256 `28bc50d8691a1a5524a772ddd66f7611785db513dd0d6b578e3bbf8d0b3ccee1`. The planning document's historical proposal labels were preserved; authorization comes from the maintainer's subsequent instructions and reviewed B.1/B.2 contracts.
- **Initial integrity:** Exactly nine untracked files, empty index and no tracked changes. The reviewed cumulative Slice 2 patch reconstructed byte-for-byte: 129,021 bytes, SHA-256 `e64e9d4e43f5ae40da75a309ab1a56283c43fcfdc0b858e049946c4fcac52ab6`. Forward/reverse review-artifact checks and the separate Slice 1/2 identities passed before edits. A comparison snapshot was retained outside the repository.

## Scope and files

| File                                                         | Change                                                                                              |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `server/src/worker/recovery-delivery-contract.ts`            | Strict versioned, generation-bound hints and deterministic job IDs.                                 |
| `server/src/worker/maintenance-recovery-authorization.ts`    | Fresh actual B.2 permit observations and explicit dedicated-configuration factory.                  |
| `server/src/worker/maintenance-delivery.repository.ts`       | Fenced delivery observations and durable terminal-generation replacement.                           |
| `server/src/worker/redis-recovery-delivery.ts`               | Bounded BullMQ producer, persisted payload verification, uncertain outcomes and connection cleanup. |
| `server/src/worker/maintenance-recovery.service.ts`          | Permit-gated metadata/delivery orchestration, independent of production composition.                |
| `server/src/worker/maintenance-recovery.spec.ts`             | Unit contract and authorization tests.                                                              |
| `server/test/recovery-delivery.redis-spec.ts`                | Real Redis duplicate, conflict, acknowledgement, restart and timeout tests.                         |
| `server/test/maintenance-delivery.maintenance-spec.ts`       | Combined PostgreSQL/Redis, real B.2 policy and synthetic storage tests.                             |
| `server/test/helpers/disposable-redis.ts`                    | Exact Redis ownership/credential/storage/port checks and synthetic data-loss fixtures.              |
| `server/vitest.config.maintenance.ts`                        | Separate bounded combined suite.                                                                    |
| `server/test/run-redis.mjs`                                  | Nested combined mode and stable-container Redis process-restart fixture.                            |
| `server/test/run-integration.mjs`                            | Combined-only selection; existing database isolation and cleanup retained.                          |
| `server/package.json`                                        | `test:maintenance` command; no dependency changes.                                                  |
| `server/test/maintenance-reconciliation.integration-spec.ts` | Separately authorized Slice 2 LOW test correction.                                                  |
| `server/test/maintenance-retry.integration-spec.ts`          | Carried-forward lost reservation acknowledgement regression.                                        |
| `docs/development/milestone-13b3-slice3-report.md`           | This report.                                                                                        |

No production module, worker registration, M12 journal implementation, migration, inspector, historical report, ADR, dependency lockfile, API or filesystem executor changed. All Slice 1/2 implementation source and reports remain unchanged. Their two test changes are explicitly identified above. The new components are unregistered; no production automatic processor, reservation, dispatch, timer or real operator action is enabled.

## Separate Slice 2 correction and carried-forward test

The stale-leader assertion now uses the next valid receipt tuple after the persisted cursor, within the fixed upper bound, before the replacement owner adopts the pass. It asserts stale-owner rejection, an unchanged durable cursor, then valid replacement-owner progress. Monotonic cursor rejection alone can no longer satisfy it. No coordinator source change was needed.

The Slice 1 regression commits an actual reservation, loses only its acknowledgement in a test wrapper, then confirms it on an independent PostgreSQL pool. Wrong generation, attempt, incarnation and permit identities are rejected. An unavailable confirmation throws; replay does not create another reservation. The durable row retains exactly one lifetime/immediate attempt and the original tuple. Reservation semantics were not changed. This closes the specified coverage gap without claiming real network-partition or power-loss certification.

## Permit integration and boundaries

`MaintenanceRecoveryAuthorization` invokes the actual `RecoveryPermitService.check(expectedGeneration)` afresh. Its explicit factory uses B.2's `permitLocation` and `createPermitPairing`, protected runtime reader and dedicated read-only database configuration. It neither loads `.env` nor falls back to ordinary application credentials. There is no synthetic authorization flag or permissive fallback in the new orchestration.

Observations occur before metadata work, discovery, checkpoint progress, terminal-generation replacement and enqueue, after Redis waits, and after enqueue. Schema, current storage identities and expected permit generation remain B.2 checks. Before delivery, the locked journal must also match the current database-wide storage-binding tuple. Permit/storage reads run outside PostgreSQL transactions. Missing, disarmed, malformed, untrusted, changed or unavailable evidence stops subsequent admission/delivery. A new permit generation never clears blocked state, changes counters or shortens cooldowns.

An already-issued Redis write may complete while the permit changes. The result is uncertain and the hint may remain; it is not an execution capability. `checkHint` is a fresh eligibility observation, not an executor guard or a reservation. B.4 must additionally bind the live attempt, permit generation and M12 claim at every required irreversible-I/O boundary. No filesystem call can be recalled retroactively.

## Redis contract and recovery

The separate `maintenance-recovery` queue carries only `{version:1, asset_id, generation}` under `deletion.execute.v1`. Canonical lowercase UUIDs, bounded decimal generations, exact keys and version are mandatory. Job IDs include receipt and generation, with no colon. No owner, path, permit or execution token is accepted.

The producer permits one outstanding logical operation per adapter, including timed-out work, with bounded connection/command/socket and operation deadlines. It disables the offline queue, uses finite producer retries and bounded terminal retention (100 completed and 100 failed, with a one-day age limit under BullMQ's lazy removal). Failed/initializing producers are force-closed through the pinned BullMQ connection API; capacity is not released merely because a timeout fired. Unknown producer disposal quarantines the adapter even if its command promise already rejected; no additional command or replacement producer is allowed. A focused fault test verifies this boundary. This is not a global cross-process semaphore or a bound on the entire waiting backlog. BullMQ upgrades require rechecking the protected forced-close integration.

Inspection verifies persisted name/payload/state. Enqueue reinspects and reads back the stored payload after `add`, since a competing producer may have won the ID. Duplicate delivery and lost acknowledgements reuse the same persisted identity. A verified absent/wiped Redis delivery can be reconstructed at the still-valid PostgreSQL generation; absence alone never resets an episode or grants authority. Retained terminal jobs require a positively committed generation replacement. Redis unavailability, uncertain state and conflicting payloads never justify replacement.

Replacement locks **journal → retry → coordinator SHARE fence**, rechecks PostgreSQL wall time, current token/epoch, pending journal, matching binding, no live asset/claim, passive state, due time and exact generation/revision. It preserves due time, counters, errors and historical evidence. Reservation races serialize on the journal: either the old reservation wins and replacement refuses, or replacement wins and the old generation cannot reserve. Unknown replacement COMMIT stops enqueue; later positive state permits recovery. No automatic reservation or clearance is performed.

All metadata transactions use `READ COMMITTED`, local synchronous commit, bounded lock/statement timeouts and existing bounded pools. No Redis, permit-file or storage operation runs under those row locks. Finite-pass metadata progress commits before best-effort Redis delivery, so Redis failure does not block otherwise safe metadata traversal; due receipts remain recoverable in a subsequent pass. Generic uncertain database mutations still stop progress, rather than being treated as rollback or success.

## Disposable infrastructure and test evidence

`npm run test:maintenance` nests the existing PostgreSQL runner under the existing Redis runner. Both retain exact name/ID, image, label, isolated credential, tmpfs-only mount, localhost-port and owned cleanup checks. The combined mode has its own test include and longer outer signal grace so the inner runner can clean up. No Compose project or persistent volume is used.

The Redis fixture supervises its ephemeral server process within the same container. Tests use verified `SHUTDOWN NOSAVE`, confirm a new server PID and retain the exact Docker network/storage identity. This avoids assuming Docker preserves randomly assigned ports across a container restart. The image's own entrypoint still starts each Redis process with its usual permissions. Wipes and restarts are available only after the exact disposable identity is reverified; command failures are sanitized.

Combined tests use actual B.2 service, parser, store, schema inspector and storage verifier. Positive policy fixtures explicitly use the operator reader under the test UID and a synthetic physical-storage observer; actual runtime-reader refusal is tested separately and the existing B.2 suite retains its independent-UID tests. This is not runtime deployment permission certification, physical media access, ext4 certification or permit arming on a real installation.

All commands ran from `server/` in the isolated worktree under Node.js 24, using the existing pinned npm installation.

| Command/check                                                                          | Actual result                                                                                                                                                          |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                                                        | Passed inside Redis, combined, PostgreSQL, migration and runtime-smoke commands; includes native helper compilation.                                                   |
| `npm run typecheck`                                                                    | Passed on final source. An initial test-only `flushdb` typing error was corrected by using a verified fixture CLI helper.                                              |
| `npm run lint`                                                                         | Passed without warnings on final source; an earlier unused test import was removed.                                                                                    |
| `npm run test`                                                                         | **249 passed**, 26 files, including 22 new Slice 3 unit cases. Rerun after the final quarantine safeguard.                                                             |
| `npm run test:e2e`                                                                     | **60 passed**, 8 files.                                                                                                                                                |
| `npm run test:integration`                                                             | **348 passed**, 18 files; **6 native-storage cases skipped**, one file. Includes the corrected Slice 2 assertion and new real reservation lost-acknowledgement case.   |
| `npm run test:redis`                                                                   | **24 passed**, two files: all 17 existing worker cases plus 7 new delivery cases. Rerun after the final producer safeguard.                                            |
| `npm run test:maintenance`                                                             | **25 passed**, one file, using both disposable services. Rerun after the final producer safeguard.                                                                     |
| `npm run test:migrations`                                                              | **106 passed**, one file; overlaps the 348-case PostgreSQL suite.                                                                                                      |
| `npm run test:runtime-smoke`                                                           | Passed: invalid configuration and unavailable authentication database exited safely.                                                                                   |
| `node test/run-redis.mjs --delivery`                                                   | **7 passed** in focused diagnostic verification; overlaps the Redis suite.                                                                                             |
| Combined runner SIGTERM probe                                                          | Passed: interrupt after both fixtures become ready; expected nonzero child exit 1, both owned cleanup messages and subsequent missing-container inspections confirmed. |
| Focused Prettier, Markdown links, tracked/untracked whitespace and patch applicability | Passed during final review preparation.                                                                                                                                |
| Hosted CI / native power-loss certification                                            | **NOT RUN**. Existing hosted workflow does not yet invoke the new combined command.                                                                                    |

An initial Redis run had **22 passing / 2 failing** cases: Docker reassigned its random host port across a container restart, correctly triggering isolation rejection and affecting the next fixture. A subsequent investigation run was interrupted after stalling, and its sole owned Redis container was explicitly verified and stopped; it is not counted as successful verification. The stable-container process-restart fixture, forced producer cleanup and focused run then passed, followed by complete successful Redis/combined reruns. A first SIGTERM probe incorrectly expected case-sensitive Docker absence text; missing-object handling was made case-insensitive in both runners without relaxing ownership checks, and the probe passed afterward. Final runner changes also received syntax/format/whitespace checks. No failed or interrupted attempt is presented as a passing suite.

All normally completed suites removed their fixtures. The final PostgreSQL and Redis ownership-label listings were empty. Abrupt host failure or SIGKILL still cannot guarantee in-process cleanup; no Docker prune or persistent-volume operation was used.

## Limitations and review handoff

- Slice 4 still owns worker lifecycle composition, independent periodic scheduling, shutdown/admission orchestration, scheduler repair and hosted integration of these pieces. B.4 owns destructive execution integration and conservative takeover. Current worker handlers remain synthetic.
- PostgreSQL, Redis and the external permit cannot commit atomically. Hints can become stale after observation; every future processor must freshly validate PostgreSQL generation, permit and actual reservation. No claim of cross-system atomicity or instantaneous disarm cancellation is made.
- Process restarts, injected acknowledgement loss and synthetic storage evidence do not establish power-loss durability, real backup recovery, network-filesystem safety or production deployment readiness.
- Dependency advisories and separately approved deployment/real-data recovery gates remain open. No real database, media, storage identity marker or persistent volume was accessed or modified.
- Incremental Slice 3 and cumulative M13B.3 patches include untracked contents and modes; sizes/hashes and check-only applicability are supplied in the review handoff. The incremental patch uses the exact reviewed Slice 2 snapshot, including only the two authorized prior-test changes. All work remains unstaged and uncommitted; independent review is required before any checkpoint or further slice.

Implementation references: pinned BullMQ `5.81.5` source was inspected alongside its [job-ID contract](https://docs.bullmq.io/guide/jobs/job-ids) and [producer failure guidance](https://docs.bullmq.io/guide/going-to-production). B.2's [permit contract](recovery-permit.md), [Slice 1 report](milestone-13b3-slice1-report.md) and [Slice 2 report](milestone-13b3-slice2-report.md) remain the preceding review records.
