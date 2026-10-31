# M13B.4.1 — Dormant Admission and Shared Claim Contract

**Status:** Implemented and locally verified; ready for independent implementation review. No checkpoint or activation authorized.

**Branch:** `feat/m13b41-dormant-admission`

**Base:** `243d0d0e15e2104c0844f0d0a89ae866f483af65` (`integration`, PR #13 merge).

**Worktree:** `/tmp/saefr-m13b41-dormant-admission`

**Contract:** M13 v3 SHA-256 `28bc50d8691a1a5524a772ddd66f7611785db513dd0d6b578e3bbf8d0b3ccee1`, authorized dormant B.4.1 scope and preceding independent security-design audit.

Related historical contracts: [ADR 0006](../decisions/0006-asset-lifecycle-and-deletion.md), [M12 specification](milestone-12-spec.md), and [B.3 report](milestone-13b3-report.md). These records are unchanged.

## Scope and files

Exactly four new files; no existing tracked implementation, test, migration, inspector, configuration, dependency or historical document is changed:

| File                                                              | Purpose                                                                                                                                  |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/worker/dormant-deletion-admission.repository.ts`      | Isolated strict manual admission, automatic reservation, exact confirmation, atomic binding/settlement and evidence-preserving blocking. |
| `server/src/worker/dormant-deletion-admission.repository.spec.ts` | Architecture test forbidding imports/registration from other production source.                                                          |
| `server/test/dormant-deletion-admission.integration-spec.ts`      | Real PostgreSQL contract, contention, fault-injection and SQL mutation controls.                                                         |
| `docs/development/milestone-13b41-report.md`                      | This report.                                                                                                                             |

There is no Nest registration, production consumer, changed HTTP contract, automatic execution, permit write, clearance operation or filesystem executor connection. Synthetic proof/preflight inputs are test contracts, not production capabilities. The class is intentionally dormant; importing it into production fails the architecture regression test.

## Transactions and identities

`open()` calls the existing exact migration-history/schema validator and requires all migrations through M13. It does not use the authentication readiness label `m12`, choose a production profile or apply a migration. Genuine M12 is rejected by this new contract while the existing M12 production path remains unchanged. Missing tables cause refusal/uncertainty, never a legacy fallback. Schema validation at opening is supplemented by fail-closed SQL errors on later disappearance; it is not a new continuous catalog monitor.

Transactions explicitly use READ COMMITTED, local synchronous commit, a two-second lock timeout and five-second statement timeout. They lock journal, retry row (if present), then storage-binding row SHARE. Journal-first locking coordinates discovery even when the retry row is absent. No Redis, filesystem, permit read or sleep occurs inside these transactions.

Guarded SQL checks the immutable receipt/owner, accepted lifecycle version, exact requested timestamp, extension, storage tuple/layout, pending journal and absence of a live asset. Storage binding must match both independently recorded role bindings. This is database evidence; physical verification remains the external caller's obligation before future activation/execution.

Strict manual claims refuse every non-NULL token, even expired; unresolved reserved/blocked execution and inconsistent closed retry states also refuse. Production `AssetDeletionRepository.claim()` is untouched and still permits legacy expired-token replacement.

Reservation requires explicit positive bigint lifetime ceiling and explicit synthetic capacity/storage/permit preflight. No unlimited/default production budget is introduced. Exact generation and microsecond due time, due/cooling state, DB-clock eligibility and counters are SQL guarded. Only committed reservation consumes a lifetime attempt; immediate count increases only from `due`. Cooling probes retain three immediate attempts. Counters and generations are never reset. A consumed reservation remains consumed even if its acknowledgement is lost.

Binding compares receipt, generation, attempt, worker incarnation, permit generation and exact database-generated reservation deadline. One caller-retained token is atomically installed in journal and retry rows. Either update affecting zero rows rolls back both. Binding never extends the reservation. Future I/O must satisfy both independent live deadlines; this slice adds no renewal or I/O.

## Uncertainty, settlement and evidence

Database-generated deadlines are returned/read as six-digit UTC PostgreSQL text; bigint identities remain strings. No JavaScript timestamp reconstruction occurs. `confirm()` performs a separate current read and returns the exact reservation/binding only while the full identity remains live. Failed/unavailable confirmation grants no authority. The caller must retain its original attempt/token and must not mint replacements after an uncertain acknowledgement.

Results distinguish positively applied, known guarded refusal and uncertain transaction/transport outcome. Refusal is deliberately coarse within this dormant repository; it grants no retry/takeover authority. Confirmation is an observation, not a capability that bypasses later permit/storage checks.

Synthetic drained-success settlement atomically completes the journal and closes the matching retry row. Synthetic drained-failure settlement atomically releases the matching token and schedules five-minute, thirty-minute or six-hour delay from PostgreSQL time while preserving counters. Both require exact live identity and deadlines. Unknown/expired/stale settlement does not clear evidence. After settlement clears attempt fields, the schema cannot prove attribution of an old uncertain callback; tests assert refusal of replay rather than inventing a durable per-attempt settlement receipt.

Blocking preserves the retry row's original token, attempt, incarnation, permit, deadline, generation and counters, including after independent journal completion or journal-token replacement. It does not copy a current NULL/different journal token. No operator clearance is issued or consumed.

## Acceptance and negative controls

The new PostgreSQL tests use independent max-one pools and observed `pg_stat_activity` lock waits for both admission orders, generation replacement races and deadline expiry during a journal-lock wait. Assertions inspect durable rows and counter changes.

Additional coverage includes missing retry rows/discovery, stale exact identities, explicit budgets/overflow, genuine historical M12 schema rejection, missing M13 tables after readiness, legacy expired-token compatibility, atomic binding/settlement rollback, independent confirmation failure and acknowledgement loss before rollback/after actual commit. Acknowledgement loss is injected around real PostgreSQL transactions; it is not a real network partition or power-loss experiment.

SQL mutation controls execute only against synthetic disposable records. They independently remove generation, attempt/incarnation CAS, manual/automatic exclusion, expired-token refusal and token evidence preservation, proving the original assertions detect valid-row mutations. No production source is mutated.

The accepted B.3 SQL-state precision follow-up is included: a test changes only the application-visible state read to reach `closeCompleted()`'s SQL with a genuinely valid closed database row. With the SQL state predicate intact, zero rows change; removing only that predicate updates the revision. CHECK violations do not supply the negative evidence.

A synthetic historical-predecessor test explicitly demonstrates the remaining boundary: legacy replacement can leave a NULL journal token without a durable record of predecessor drainage. The strict dormant database contract cannot infer that missing history. It is not safe to activate this contract solely because M13 tables exist.

## Initial implementation verification (before LOW correction)

The initial implementation verification used Node.js **24.22.0**, Docker **29.8.2** and PostgreSQL **18** / Redis **7.4** containers from the unchanged ownership-verified runners. Resource-heavy suites ran sequentially. The final frozen-source rerun passed on 2026-11-01.

| Command                      | Actual result                                                                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`              | PASS, including native helper build.                                                                                                                             |
| `npm run typecheck`          | PASS.                                                                                                                                                            |
| `npm run lint`               | PASS, no warnings in final run.                                                                                                                                  |
| `npm run test`               | PASS: 269 tests across 29 files.                                                                                                                                 |
| `npm run test:e2e`           | PASS: 60 tests across eight files.                                                                                                                               |
| `npm run test:integration`   | PASS: 406 tests; six native-storage tests skipped; 19 files passed and one skipped. Includes existing migration regressions and all new dormant admission cases. |
| `npm run test:maintenance`   | PASS: 54 tests across two files with disposable PostgreSQL and Redis.                                                                                            |
| `npm run test:redis`         | PASS: 48 tests across four files with disposable Redis.                                                                                                          |
| `npm run test:runtime-smoke` | PASS: invalid configuration and unavailable authentication database both exit safely nonzero.                                                                    |
| Focused Prettier             | PASS: all four new files.                                                                                                                                        |
| Markdown references          | PASS: three relative historical-document links resolve.                                                                                                          |
| Tracked/untracked whitespace | PASS; cumulative patch checked against clean index and reversed against current files.                                                                           |

Final static/unit/PostgreSQL evidence is retained outside the repository in `/tmp/saefr-b41-frozen-verification.json` and its referenced logs. HTTP, maintenance, Redis and smoke evidence is in `/tmp/saefr-b41-verification.json` and its logs. Intermediate runs were followed by a final frozen-source rerun after narrow inspection corrections. All owned containers were removed; final ownership-label listings were empty. No hosted CI run was requested or performed. Native ext4 certification was not run. The standalone `test:migrations` command was not separately rerun; its migration file is included in the full PostgreSQL suite.

SQL negative controls are passing tests that assert a deliberately weakened test-only query can perform the forbidden valid-row mutation. No production source is temporarily or permanently weakened. These are distinct from intentionally failing a whole test command.

## Data safety and environment

The original checkout and its three untracked planning documents, existing B.3 worktree and all unrelated branches were preserved. A new authorized feature branch/worktree was created from the verified baseline. Nothing was staged or committed.

All database fixtures/migrations ran only in randomly named disposable databases after container identity, ownership labels, credentials, localhost port, tmpfs and auto-removal checks. No Compose command, persistent volume or ordinary application credentials were used. Synthetic journal targets never caused media access or filesystem removal.

Initial verification issues are retained as evidence: the first typecheck exposed an incorrect constant import and widened literal result types; those were fixed. Sharing read-only dependencies through a symlink prevented Vite cache creation, so dependencies were copied into this worktree without changing lockfiles or installing new packages. The first full PostgreSQL run had 368 passing, 26 failing and six skipped cases: new test proxy receivers and a missing query alias were corrected; existing permit tests rejected the sandbox-mapped `/tmp` owner. Running the unchanged suite with actual host ownership resolved those environment failures. That failed run removed its container. Subsequent intermediate PostgreSQL runs passed 396 and 406 cases respectively, with six native cases skipped; these do not substitute for final-snapshot verification.

## Remaining gates and limitations

- Lifetime automatic execution policy is unresolved. Test ceilings are explicit synthetic inputs, not approved production thresholds.
- Strict manual behavior requires a separately approved, externally fenced cutover proving predecessor drainage and consistent process configuration. Installed M13 schema or a NULL token cannot establish this.
- Strict crashed manual tokens may remain pending indefinitely; their recovery procedure is deferred. Existing automatic clearance records cannot identify every displaced historical manual predecessor.
- B.4.2 must supply real permit/storage revalidation, capacity/drainage tracking, both-deadline checks and executor integration. A Boolean proof in this dormant contract cannot establish physical quiescence.
- B.4.3 owns operator-mediated clearance. No self-clearance, expired-token takeover or production activation is provided here.
- One API/two manual slots plus one worker/one automatic slot requires separately verified supervision and rollback fencing. This repository does not enforce a distributed global semaphore.
- Native ext4 certification, host power-loss durability, deployment topology and real restore/upgrade rehearsal are not established by these tests.
- Existing dependency advisories remain follow-up work; no dependency audit/remediation is claimed in this slice.
- No real-data migration, storage adoption, permit arming, deployment, commit, push or PR is authorized by this report.

## Reproduction and review gate

From `server/`, run `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:e2e`, `npm run test:integration`, `npm run test:maintenance`, `npm run test:redis` and `npm run test:runtime-smoke`. Database suites must retain the existing disposable runner, never use development PostgreSQL. Permit tests require a real, trusted filesystem ownership view; do not weaken their ownership checks to accommodate a sandbox.

Run focused Prettier over the four new files, validate report links, inspect the cumulative patch (including untracked additions), and run Git whitespace/applicability checks. Independent implementation review and separate checkpoint approval remain required. B.4.2/B.4.3 have not started.

## Focused LOW coverage correction — 2026-11-01

The independent implementation review returned PASS with one LOW test-coverage finding. The earlier two-case fixture exercised a second immediate attempt and an existing cooling probe, but did not exercise the third immediate attempt's transition into cooling or independently bound the thirty-minute/six-hour delays.

This corrective pass changes only `server/test/dormant-deletion-admission.integration-spec.ts` and this report relative to the reviewed four-file snapshot. The production repository and dormancy unit test retain their reviewed hashes; all existing negative controls and other tests are preserved. No implementation defect was exposed or fixed.

The replacement has three explicit cases: `due` with one prior immediate attempt → second immediate attempt, `due` with two prior immediate attempts → third immediate attempt, and `cooling` with three prior immediate attempts → cooling probe. Each starts with seven lifetime attempts, verifies exactly eight after reservation and settlement, verifies the exact reservation identity and attempt kind, then asserts the expected state and cleared execution evidence. Duplicate and stale-incarnation settlement must leave the full settled snapshot unchanged.

Independent PostgreSQL clock readings before and after the actual settlement bracket `next_eligible_at`: it must be at least the before reading plus the expected delay and at most the after reading plus that delay. The second attempt uses thirty minutes; third immediate and cooling probe use six hours. Both early and late scheduling errors are detected. All six fractional digits remain PostgreSQL timestamp text; no JavaScript clock or Date conversion, arbitrary timing tolerance or sleep is used.

### Actual corrective verification

| Command                                                                                             | Outcome                                                                                                                     |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `node /tmp/saefr-b41-low-focused-runner.mjs` (from `server/`)                                       | PASS: three focused cases; 49 unrelated cases unselected.                                                                   |
| `npm run test:integration`                                                                          | PASS: 407 tests, six native-storage cases skipped; 19 files passed and one skipped. Existing negative controls also passed. |
| `npm run typecheck`                                                                                 | PASS.                                                                                                                       |
| `npm run lint`                                                                                      | PASS.                                                                                                                       |
| `npm run build`                                                                                     | PASS, including native helper build.                                                                                        |
| Focused Prettier, relative Markdown links, tracked/untracked whitespace and cumulative patch checks | PASS.                                                                                                                       |

The focused runner is an external temporary copy of the existing PostgreSQL runner with only Vitest file/name arguments added. Its ownership, isolated credentials, loopback port, tmpfs and cleanup checks are unchanged. Focused/full positive runs and all mutation runs removed their owned containers. The current 407-test result supersedes the earlier 406-test count; earlier unit/HTTP/Redis/maintenance/smoke results above remain historical evidence and were not rerun for this correction. No hosted CI or native certification was performed.

### Regression-sensitivity evidence

`python3 /tmp/saefr-b41-low-mutations.py` ran five deliberately broken variants in a separate non-Git source copy at `/tmp/saefr-b41-low-mutations-5qkre7i2`. The reviewed worktree's implementation was never mutated. Each variant ran only the three focused tests through the same disposable runner and exited **1 as expected**, with an assertion failure rather than an unrelated CHECK rejection:

- Second-attempt delay shortened from thirty to five minutes: lower bound failed.
- Second-attempt delay lengthened to sixty minutes: upper bound failed.
- Third/probe delay shortened from six hours to thirty minutes: both six-hour cases failed their lower bounds.
- An extra lifetime-counter increment during settlement: exact lifetime accounting failed.
- Third/probe transition changed to database-valid `closed` with NULL due time: explicit expected `cooling` state failed. Clearing due time in this mutation prevents a shape CHECK from masking the state assertion.

These intentional mutation failures are sensitivity evidence, not failures of the corrected implementation. The copied implementation was restored afterward. Logs and results are outside the repository in `/tmp/saefr-b41-low-focused.log`, `/tmp/saefr-b41-low-full.log`, `/tmp/saefr-b41-low-mutant-*.log` and `/tmp/saefr-b41-low-mutation-results.json`.

The LOW follow-up is addressed in code and awaits maintainer review. All dormant-scope restrictions, unresolved lifetime policy, fenced-cutover requirements and B.4.2/B.4.3 gates remain in force. Nothing was staged, committed or pushed.
