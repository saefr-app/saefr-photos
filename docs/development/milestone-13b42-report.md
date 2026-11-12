# M13B.4.2 — Controlled execution and provider dispatch guards

**Status:** Focused MEDIUM correction implemented; verification recorded below. Uncommitted, not activated, pending independent security re-review.

**Reference:** `integration` at `1ce86a84916c93b0a9a0ff296c32e7232cc03144` (merged B.4.1).

**Worktree:** `/home/kartik/.codex/worktrees/m13b42-controlled-execution/saefr-photos`, detached HEAD at that reference, as explicitly authorized after the earlier temporary worktree disappeared. This is a reconstruction from the approved task and merged code, not byte-for-byte recovery of the lost draft. The registered missing `/tmp` worktrees and existing branches are preserved. No feature branch is reassigned.

**Contracts:** Approved M13 v3 SHA-256 `28bc50d8691a1a5524a772ddd66f7611785db513dd0d6b578e3bbf8d0b3ccee1`; [ADR 0006](../decisions/0006-asset-lifecycle-and-deletion.md), [M12 specification](milestone-12-spec.md), [B.4.1 checkpoint](milestone-13b41-report.md), and [B.2 permit contract](recovery-permit.md). Historical documents are unchanged. The original checkout's three untracked M13 planning documents remain there.

## Inventory and scope

Four modified files:

- `server/src/assets/asset-deletion.executor.ts`: delegates the existing ordered removal/persistence callbacks to a shared sequence. Manual claims, renewals, result semantics and failure categories are retained.
- `server/src/storage/local-storage.provider.ts`: adds explicit guarded removal and persistence methods around the existing pinned-directory mechanics. Existing manual methods keep their signatures and unguarded behavior.
- `server/src/storage/storage-provider.ts`: adds the separate guarded-provider interface and fresh-observation/synchronous-dispatch guard contract. The ordinary provider interface is unchanged.
- `server/src/worker/dormant-deletion-admission.repository.spec.ts`: permits the single dormant controlled source to reference the dormant repository types, while independently forbidding imports of the controlled executor from any other production source.

Five additions:

- `server/src/assets/asset-deletion-steps.ts`: shared original-remove/persist then thumbnail-remove/persist ordering.
- `server/src/storage/guarded-deletion.spec.ts`: synthetic provider-boundary unit tests.
- `server/src/worker/controlled-deletion.executor.ts`: explicitly constructed dormant executor; no Nest registration, HTTP endpoint, consumer or configuration switch.
- `server/test/controlled-deletion.integration-spec.ts`: real PostgreSQL, real local unlink/fsync and synthetic physical-observation tests.
- `docs/development/milestone-13b42-report.md`: this evidence and limitations.

No database migration, schema/type change, historical inspector, dependency, authentication, public DTO, operator command, Redis delivery or production composition changes.

## Execution authority and M12 reuse

The controlled constructor requires the opened B.4.1 repository, B.2 permit service, an explicit guarded provider and its worker incarnation. It accepts a bound immutable receipt/attempt tuple, never a queue-selected path. The caller's tuple is copied and frozen before asynchronous work. The B.4.1 SQL remains unchanged and supplies pending-journal authority, exact timestamp/storage/layout/extension identity, absence of a live conflicting asset, generation, attempt, incarnation, permit generation, token and both live DB-clock deadlines.

A fresh guard runs at entry, before each role, within each provider's final boundary, before persistence, and before settlement. It independently confirms the reservation, verifies the current storage binding, calls the real B.2 service with the exact permit generation after external waits, confirms the exact database authority again, and checks local admission synchronously. No renewal extends automatic deadlines. No row lock or checked-out database transaction spans permit reads or filesystem I/O. Database work uses the existing B.4.1 short journal → retry → binding transactions.

The shared sequence preserves original-before-thumbnail removal and the existing additional per-role directory-persistence confirmation. Actual target validation, no-follow pinning, regular-file checks, unlink, ENOENT handling and pinned directory sync remain in the existing LocalStorageProvider. This is not a second file-removal implementation. The production manual executor retains its two slots, finite thirty-second start budget, claim replacement/renewal rules and public result contract; strict B.4.1 manual admission is not activated.

## Last-boundary behavior and unavoidable races

`removeExactGuarded()` and `confirmDirectoryPersistenceGuarded()` require an explicit guard and expected binding; missing values refuse instead of falling back to manual methods. After asynchronous pinning, physical verification and regular-file inspection, the provider awaits fresh authorization and checks the synchronous local fence immediately before entering `unlinkPath()`. Equivalent guards protect directory sync after unlink, verified absence and explicit persistence confirmation. Existing post-I/O binding verification remains mandatory. A refusal after unlink leaves a pending, unresolved attempt rather than asserting durable completion.

These observations do not atomically fence PostgreSQL, permit files and filesystem syscalls. Another process can change authority after its last observation; disarm cannot retract an issued unlink or fsync, including one queued in the runtime/kernel. A deterministic held-call test disarms after dispatch and demonstrates that the issued original removal may finish while subsequent persistence and thumbnail removal are denied. The supported restore procedure still requires independently enforced process fencing and positive drainage before changing database/media pairing. No instantaneous revocation or power-loss guarantee is claimed.

## Capacity, shutdown and outcomes

One slot per controlled executor is installed synchronously before guard work. The thirty-second monotonic start budget, cancellation and shutdown close new local dispatch. The slot is retained until every awaited provider call and result handling actually settles; no timeout races, detached provider promise or expiry-based release exists. `shutdown()` closes admission synchronously and waits for that actual local drain. It may remain pending indefinitely for an unresponsive call; supervisors still need a fenced termination procedure. Local drainage does not resolve unknown remote PostgreSQL commits.

Confirmed durable removal of both roles uses B.4.1 atomic success settlement. A positively settled pre-unlink failure, with fresh authority and no unknown I/O, uses its atomic known-failure/cooldown transition. Uncertain unlink/persistence, interruption, permit/storage refusal and unknown database acknowledgements never become completion or an ordinary retry. Exact original identity is supplied to conservative blocking; its original token/attempt evidence is not replaced by a fresh read. A blocked-write acknowledgement may itself be uncertain or refused and is never represented as proof of durable blocking.

All refused/uncertain execution paths latch this local executor closed, including when blocking cannot be acknowledged. There is no reset/self-clearance method. A separate later incarnation and approved B.4.3 protocol remain prerequisites for recovery; reconstructing an object or reusing an incarnation is not an approved recovery mechanism. Confirmed success/known-failure paths may release the local slot normally. This is not distributed capacity enforcement or an enforcement mechanism for process counts.

Internal results distinguish completed, known failure, admission refusal, stale authority, interruption, database uncertainty, provider uncertainty, storage mismatch and permit denial. `stale` reports the lack of a matching current executable tuple; it does not infer a precise cause from B.4.1's coarse refusal. An existing unresolved predecessor remains identifiable by its preserved `blocked_execution` state/evidence and is tested explicitly. No operator clearance is issued or consumed.

## Isolation and tests

The unchanged repository runners and `testConfig()` validate unique container ID/name/image/ownership label, tmpfs-only mounts, isolated generated credentials/database, localhost port and ownership-checked cleanup. The PostgreSQL tests create a uniquely named database inside that verified disposable PostgreSQL 18 container. Redis/combined tests use the existing disposable Redis 7.4 runner. Neither runner uses Compose, persistent volumes, the ordinary application `.env` or development credentials.

Each controlled test uses a newly allocated private temporary root. The real StorageBindingVerifier consumes synthetic marker bytes and inode-derived physical evidence through an explicitly test-only observer; LocalStorageProvider performs real pinned-directory unlink/fsync. This is synthetic provenance evidence, not native ext4 certification. The real B.2 service and DatabasePermitPairing inspect the migrated database and both roles. As in the established B.2 tests, the same-UID fixture substitutes `readOperator()` for the runtime-reader method; production separate-UID/read-only control-mount enforcement remains covered by the existing permit suite, not re-proven by this adapter. No actual operator initialize/arm/clearance command is invoked.

Coverage includes confirmed success and order, immutable target tampering, missing/live-conflicting journals, exact stale attempt/incarnation/generation/token, exact expired deadlines and expiry during an outstanding call, disarm/replacement during held preparation, both replaced role directories with copied markers, symlink/unsupported storage, pre-cancellation, shutdown/deadline during held I/O, duplicate local admission, original-only partial deletion, known pre-unlink failure, unknown unlink/fsync, no transaction during held filesystem I/O, a genuinely closed PostgreSQL pool, settlement before/after lost acknowledgement, generation change before settlement, unresolved predecessors, competing manual tokens, verified absence persistence and the local uncertainty latch. Barriers use held promises rather than sleeps. Durable rows and actual remaining files are asserted.

## Initial reconstruction verification — before MEDIUM correction

Executed on 2026-11-01 with Node.js 24.22.0 and Docker 29.8.2. Heavy suites ran sequentially through the unchanged repository-owned runners.

| Command                                    | Actual result                                                                                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                            | PASS, including native helper compilation; compilation is not certification.                                                                                   |
| `npm run typecheck`                        | PASS.                                                                                                                                                          |
| `npm run lint`                             | PASS.                                                                                                                                                          |
| `npm run test`                             | PASS: 274 tests, 30 files, including five new provider boundary cases and existing M12 executor tests.                                                         |
| `npm run test:e2e`                         | PASS: 60 tests, eight files.                                                                                                                                   |
| `npm run test:integration`                 | PASS: 455 tests; six native-storage cases skipped; 20 files passed and one skipped. Includes 48 controlled-execution cases and existing migration regressions. |
| `npm run test:maintenance`                 | PASS: 54 tests, two files, disposable PostgreSQL and Redis.                                                                                                    |
| `npm run test:redis`                       | First run: 47 passed, one failed. Full rerun: PASS, all 48 tests/four files. Details below.                                                                    |
| `npm run test:runtime-smoke`               | PASS: invalid configuration and unavailable authentication DB exit nonzero without sensitive output.                                                           |
| Focused controlled PostgreSQL run          | PASS: 44 cases before four final additional tests; all final 48 cases passed in the full suite.                                                                |
| Eleven isolated negative controls          | All failed as intended through assertions; source restored in the mutation copy.                                                                               |
| Focused Prettier                           | PASS over the eight TypeScript files and this report.                                                                                                          |
| Relative Markdown references               | PASS: all four links resolve.                                                                                                                                  |
| Git whitespace and cumulative patch checks | PASS, including untracked additions, forward check against the clean index and reverse check against the current worktree.                                     |

The first standalone Redis run failed the unchanged `worker-shutdown.redis-spec.ts:221` expectation that an initialized producer's `end` event had not yet occurred after observing the proxy FIN. It observed `true` instead of `false`. That test and every worker/Redis implementation file are unchanged from the baseline. The exact focused test passed (one selected case, three unselected), followed by the full 48-test disposable Redis rerun passing. No test or worker code was changed to obtain that result. This is retained as an observed intermittent transport-event timing limitation, not dismissed as a proven infrastructure failure or a confirmed new production defect. The full-regression driver stopped at its initial Redis failure; smoke was then executed separately and passed. The original failed run is not overwritten by the rerun evidence.

During implementation, a 43-case focused run had 42 passes and one test failure: reasserting an existing execution block advanced its audit revision. The corrected assertion preserves exact journal/attempt/token/state/counters while permitting that revision to advance. Its first edit used `updated_at`, which typecheck rejected because RetrySnapshot exposes `updated_at_exact`; this test-only field was corrected. The subsequent focused 44-case run and final 48-case full-suite coverage passed. The lost draft's previously reported misplaced upload guard was not recovered; reconstruction confines guards to deletion methods, and publication/open bodies are byte-identical to the baseline. Current build/typecheck pass.

Those commands passed for the initial reviewed snapshot, with the Redis timing observation retained as a follow-up. The subsequent independent implementation review returned FAIL for the persistence-uncertainty defect described below; green initial suites did not establish its absence. Migration cases are included in the full PostgreSQL run; a separate migration-only run was not repeated. Hosted CI and native filesystem/power-loss certification were NOT RUN. All disposable containers from positive, failed and negative-control runs were removed.

Machine-readable command results are `/tmp/saefr-b42-final-verification.json` (including the first Redis failure) and `/tmp/saefr-b42-redis-rerun.json`. Logs use `/tmp/saefr-b42-final-*.log`, `/tmp/saefr-b42-redis-recheck.log` and `/tmp/saefr-b42-redis-rerun.log`. Copies of final evidence and mutation logs are retained outside the Git worktree in the adjacent `review-evidence/` directory.

## Initial reconstruction negative controls — before MEDIUM correction

`python3 /tmp/saefr-b42-mutations.py` ran eleven deliberate defects in `/tmp/saefr-b42-mutation-copy-2`, a separate non-Git source/dependency copy. All exited 1 with the intended assertion failure, rather than a CHECK violation or setup failure:

| Mutation                                                | Observed regression                                                                    |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Omit permit revalidation after held storage observation | Completed instead of permit denied.                                                    |
| Omit attempt comparison                                 | Completed with a different DB attempt.                                                 |
| Omit incarnation comparison                             | Completed with a different DB incarnation.                                             |
| Omit journal/retry token matching during confirmation   | Performed removals, then returned database uncertainty instead of refusing before I/O. |
| Omit reservation time check                             | Started I/O for an exactly matched expired deadline; subsequent settlement refused.    |
| Omit provider unlink boundary guard                     | Removed the file after permit disarm during pinned preparation.                        |
| Omit post-removal binding recheck                       | Claimed durable removed instead of uncertain after synthetic binding replacement.      |
| Release local capacity while call remains held          | Duplicate call completed instead of being refused.                                     |
| Treat unknown unlink as success                         | Completed instead of reporting provider uncertainty.                                   |
| Remove local uncertainty latch                          | Replayed and completed an attempt whose blocking write was unknown.                    |
| Omit generation CAS in settlement                       | Completed after generation changed following the final observation.                    |

The inspected mutation logs are `/tmp/saefr-b42-mutant-*.log`; machine-readable results are `/tmp/saefr-b42-mutation-results.json`. Every owned container was removed. Three mutated source files were restored in the copy and byte-compared with the reconstructed worktree before the MEDIUM correction. The worktree source was never deliberately mutated. The copy's test file predates four final additional coverage cases; all mutated assertions remain unchanged.

The first mutation-copy attempt excluded dependency `dist` directories and failed before Vitest loaded. It was not counted as sensitivity evidence; its disposable container was removed. A complete second dependency copy produced the eleven valid assertion failures above.

## Focused MEDIUM persistence-uncertainty correction

The independent security review returned **FAIL** for one confirmed MEDIUM defect. A valid bound automatic attempt could encounter an already-absent original, submit directory sync, lose its acknowledgement and receive `unavailable` because the legacy `removalAttempted` flag was still false. The controlled executor interpreted this as known pre-unlink failure, invoked atomic ordinary failure settlement, cleared journal/retry tokens and attempt identity, and set the retry row to `due`. The journal remained pending and the thumbnail remained present; the defect was premature uncertainty-evidence clearance, not unauthorized journal creation or false completed deletion.

Before editing, the nine-file snapshot was regenerated and matched the old 78,246-byte patch SHA-256 `22d02d494459db8df847b39022665059df94a426d658e981f97175ccf6e70153`, every manifest hash/mode, the unchanged detached HEAD and empty index. The existing external probe was rerun through the ownership-checked disposable runner and reproduced `known_failure`, pending journal, NULL journal token, `due` retry state, NULL attempt/retry token, and a remaining thumbnail. Its hook threw after actual directory sync, modelling lost acknowledgement rather than assuming no operation occurred.

### Narrow classification correction

Only `local-storage.provider.ts`, `guarded-deletion.spec.ts`, `controlled-deletion.integration-spec.ts` and this report change relative to that reviewed snapshot. The overall cumulative inventory remains nine files (four tracked modifications and five additions). Controlled executor, B.4.1 SQL, public interfaces, production composition, migrations and Redis/shutdown files are unchanged.

The provider now marks **guarded absence persistence** immediately before dispatching directory sync. Once that phase is reached, an exception from sync, acknowledgement loss or post-sync binding verification produces `uncertain`, even when this attempt never submitted unlink. A genuine refusal before unlink/persistence remains `unavailable`; successful sync plus verification still returns durable `absent`. The phase marker is never enabled by the ordinary manual method, preserving its historical result classification. Existing guarded unlink uncertainty and explicit persistence-confirmation behavior are retained.

The unchanged controlled executor consequently follows its existing `provider_unknown` blocking/latching path instead of `known_failure` settlement. Journal remains pending; journal claim, retry generation/attempt/incarnation/permit/token/deadline and counters remain protected. No next destructive step starts, no ordinary eligibility is scheduled, and no new reservation or replay is accepted while unresolved. If the blocking acknowledgement is uncertain, the test leaves the actual reserved row unchanged and confirms that local admission stays closed; no durable block is falsely claimed and ordinary settlement is never a fallback.

### Added regression coverage

Twenty provider unit cases cover both roles, guarded and manual methods, sync failures, lost acknowledgements after real sync, failed post-sync verification, genuine non-regular-target refusal before mutation/persistence, and successful authoritative absence. They assert exact result categories and actual unlink/sync counts, including unchanged legacy `unavailable` classifications.

Twelve real PostgreSQL controlled-execution cases cover both roles for lost/failed sync and post-sync verification, uncertain blocking acknowledgements, genuine known pre-I/O refusal and successful authoritative absence. Original absence leaves the thumbnail untouched; thumbnail absence follows safely completed original work. They inspect the actual provider result, dispatched roles, pending journal, unchanged original claim, full retry identity/deadline/counters, absence of ordinary settlement, blocked/reserved state, replacement-reservation refusal and local replay refusal. No new mocks of successful file removal replace the real provider.

### Correction-specific negative controls

Five isolated mutations ran through the repository-owned disposable runner in a separate non-Git source/dependency copy. Each selected one actual regression and failed with an assertion, without unrelated CHECK rejection:

| Deliberate defect                                         | Actual assertion that detected it                                                        |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Ignore guarded persistence phase in catch classification  | Actual `unavailable` differed from expected provider `uncertain`.                        |
| Map provider uncertainty into ordinary failure settlement | Actual `known_failure` differed from expected `provider_unknown`.                        |
| Clear the unresolved journal token while blocking         | Actual NULL token differed from the original token; blocked state itself remained valid. |
| Convert uncertainty to ordinary retry eligibility         | Actual database-valid `due` differed from expected `blocked_execution`.                  |
| Continue after original-role uncertainty                  | Actual dispatched roles `[originals, thumbnails]` differed from `[originals]`.           |

The lost-acknowledgement injection fires once so a broken continuation can reach thumbnail removal; a later repeated injected failure cannot mask that defect. Token-clearing and retry-eligibility mutants produce valid schema states, isolating the intended evidence/state assertions.

The first mutation harness filter selected zero cases because parameterized names contain formatting. The harness rejected that exit-0/all-unselected result; it was not counted as regression evidence. Its log/results were preserved with the `initial-unselected-` prefix. A corrected external filter and a fresh copy produced all five intended failures. Original and mutation-run containers were removed. The three files mutated only in the external copy were restored and compared to the actual corrected worktree.

### Actual correction verification

Executed on 2026-11-01 using Node.js 24.22.0, Docker 29.8.2 and the unchanged PostgreSQL 18/Redis 7.4 disposable runners. Resource-heavy commands ran sequentially after the negative controls. Final code/test content was frozen before this run; only this report was completed afterward.

| Command/check                          | Actual corrected-snapshot result                                                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                        | PASS, including native helper compilation only.                                                                                                                      |
| `npm run typecheck`                    | PASS.                                                                                                                                                                |
| `npm run lint`                         | PASS.                                                                                                                                                                |
| Focused provider/manual unit command   | PASS: 42 tests, three files (`guarded-deletion.spec.ts`, `local-storage.provider.spec.ts`, `asset-deletion.executor.spec.ts`).                                       |
| Focused controlled PostgreSQL runner   | PASS: all 60 controlled-execution cases.                                                                                                                             |
| `npm run test`                         | PASS: 294 tests, 30 files.                                                                                                                                           |
| `npm run test:e2e`                     | PASS: 60 tests, eight files.                                                                                                                                         |
| `npm run test:integration`             | PASS: 467 tests; six native-storage cases skipped; 20 files passed and one skipped. Includes all 60 controlled cases, existing manual/M12 and migration regressions. |
| `npm run test:maintenance`             | PASS: 54 tests, two files.                                                                                                                                           |
| `npm run test:redis`                   | PASS: all 48 tests, four files, first full run for this correction. No Redis file changed; prior LOW timing observation remains deferred.                            |
| `npm run test:runtime-smoke`           | PASS: safe nonzero exit for invalid configuration and unavailable authentication DB.                                                                                 |
| Five correction-specific mutations     | All exited 1 with the targeted provider-result, outcome, token, state or dispatch assertion. No CHECK violation supplied the failure.                                |
| Focused Prettier / Markdown references | PASS for all nine cumulative files / all four relative report links.                                                                                                 |
| Whitespace / cumulative patch checks   | PASS, including untracked files, modes/hashes, forward check against the clean index and reverse check against the current worktree.                                 |

No required check was left unrun in this correction. Historical migration tests were included in the full PostgreSQL suite; no separate migration-only rerun was needed because no schema/migration/inspector changed. Native filesystem certification, power-loss experiments, hosted CI and real-data upgrade/recovery rehearsals were NOT RUN. The six native-storage skips are not native certification.

The final driver/results are `/tmp/saefr-b42-correction-final-checks.py` and `/tmp/saefr-b42-correction-final-results.json`; final logs are `/tmp/saefr-b42-correction-final-*.log`. Focused evidence uses `/tmp/saefr-b42-correction-focused-*.log`. Mutation script/results/logs use `/tmp/saefr-b42-correction-mutations.py`, `/tmp/saefr-b42-correction-mutation-results.json` and `/tmp/saefr-b42-correction-mutant-*.log`. Copies are retained beside the worktree in `review-evidence-persistence-correction/`.

There were no unexpected implementation/test failures during the correction. The initial all-unselected mutation-harness attempt is preserved separately and excluded from successful sensitivity evidence. All owned containers from reproduction, focused verification, mutations and full suites were removed; final ownership-label listings were empty. Original worktrees/registrations and the three planning documents are preserved. No development database, persistent volume or real media was accessed or modified. HEAD remains detached at the approved baseline and the index is empty. Nothing was staged, committed, pushed or activated.

The complete corrected cumulative patch and updated status/mode/hash manifest use the `saefr-m13b42-persistence-corrected-` prefix outside the Git worktree. The original defective patch and manifest remain untouched. Exactly four files differ from that reviewed snapshot; the other five retain their original hashes. Independent re-review is now requested, not asserted as completed.

### Deferred gates

The independent review also recorded the existing LOW `worker-shutdown.redis-spec.ts:221` timing observation: the ioredis connector and adapter disposal deadline both use approximately two seconds. The source still requires positive transport retirement and old-command settlement; an early real `end` event can invalidate the test's timing assumption. No Redis/shutdown implementation or test is changed here. Any new Redis verification failure is reported with its actual logs, not silently discarded.

B.4.3 operator clearance remains unimplemented. B.4.4/B.4.5 remain separately authorized later work; historical predecessor drainage, strict manual cutover, unique incarnation/process-topology enforcement, production integration/activation, native conformance and power-loss certification remain unmet gates. This correction does not authorize or implement any of them. Automatic recovery stays production-disconnected. Independent re-review of the corrected patch is required; this report does not approve itself.

## Production dormancy and remaining review gates

Production AppModule, AssetsModule, worker module/runtime, maintenance composition, configuration, permit operator, M12 journal repository and B.4.1 SQL implementation are unchanged. The updated architecture unit gate rejects any production source importing or naming the controlled executor and restricts dormant repository references to the single controlled source. The new class has no decorators, runtime factory registration, queue consumer, HTTP route or activating environment variable. Synthetic preflight inputs remain test contracts. No automatic permit arming, clearance issuer or recovery consumer is added.

Outstanding before activation: independent review of this exact patch; B.4.3 operator clearance; historic predecessor fencing and drainage; strict manual-profile cutover; unique incarnation and supported process-topology enforcement; approved lifetime execution ceilings; controlled restore/upgrade/backup rehearsal; native ext4 conformance and host power-loss durability; broader platform certification; existing dependency advisories. Redis consumer/executor integration remains disconnected. No production readiness, real-data migration or deployment is claimed.

## Repeating verification and handoff

From this worktree's `server/`, run `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:e2e`, `npm run test:integration`, `npm run test:maintenance`, `npm run test:redis` and `npm run test:runtime-smoke`. Retain all runner isolation checks. The full PostgreSQL command includes controlled storage and historical migration cases; never invoke these against development PostgreSQL.

The external focused runner `/tmp/saefr-b42-focused-runner.mjs` is a copy of the repository PostgreSQL runner with only the controlled-test file argument added. It preserves every resource/cleanup safeguard. Final full-source verification uses the unchanged repository runners. Check formatting only on this report and the eight changed/new TypeScript files. Validate the four relative links above and inspect the complete cumulative patch, including untracked files, with forward and reverse check-only application. Keep the index empty. Review artifacts and checksums are supplied separately so the report does not embed its own patch hash.
