# Milestone 13B.3 — Runtime reconciliation completion report

- **Status:** Final independent Astra audit returned **FAIL** for completion-evidence loss. The focused completion and sticky-error corrections below are implemented; independent re-review remains required. Unstaged and uncommitted; no self-approval, checkpoint approval or B.4 authorization.
- **Branch/base:** `feat/m13b3-runtime-reconciliation` at `8ef39c835fa0c18a31cfe63a6ae63b645427f201`.
- **Date:** 2026-10-30; corrective pass 2026-10-31.
- **Authority:** Explicit Slice 4 maintainer authorization following independent PASS verdicts for Slices 1–3. Approved M13 v3 SHA-256: `28bc50d8691a1a5524a772ddd66f7611785db513dd0d6b578e3bbf8d0b3ccee1`. Its historical proposal labels are preserved; subsequent explicit approvals establish this implementation scope.

## Provenance and completed scope

Before editing, branch, HEAD, empty index and exactly three tracked modifications plus twenty untracked files were verified. The complete Slice 3 baseline reconstructed byte-for-byte, including modes: 221,253 bytes, SHA-256 `07b9ec6846f71e5a7ed30ffddcccf237052faf20545b945e47c68acda65fa90e`. The previous artifacts and reports remain intact. An external comparison snapshot preserves every reviewed file.

- [Slice 1](milestone-13b3-slice1-report.md): exact PostgreSQL timestamps/bigints and journal-first retry primitives, including positive reservation confirmation after uncertain COMMIT.
- [Slice 2](milestone-13b3-slice2-report.md): database-clock coordinator lease, finite durable passes, exact checkpoint CAS and conservative completion sweep.
- [Slice 3](milestone-13b3-slice3-report.md): actual B.2 permit observations, bounded Redis producer, strict hints, terminal generation replacement, uncertainty quarantine and combined tests.
- Slice 4: opt-in passive production composition, independent bounded runtime and renewal, shutdown/reconnection, fenced production discovery, deterministic race correction, additional integration/process coverage and hosted-suite wiring.

The final review manifest outside the repository enumerates the complete cumulative file set and identifies unchanged earlier additions. The original Slice 4 changed these fifteen paths; the corrective additions are listed separately below:

| File                                                         | Final change                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `server/src/worker/maintenance-config.ts`                    | Explicit bounded configuration, disabled by default.                                                           |
| `server/src/worker/maintenance-runtime.ts`                   | Independent scheduling, ownership confirmation, renewal, deadline admission checks and lifecycle drain.        |
| `server/src/worker/maintenance-composition.ts`               | Dedicated database writer and real read-only permit probe; no recovery producer or consumer.                   |
| `server/src/worker/maintenance-runtime.spec.ts`              | Seventeen configuration/lifecycle/uncertainty unit cases.                                                      |
| `server/src/worker/maintenance-reconciliation.repository.ts` | Adds `discoverFenced`; existing historical coordinator operations remain intact.                               |
| `server/src/worker/maintenance-recovery-authorization.ts`    | Fresh current-generation observation through B.2.                                                              |
| `server/src/worker/maintenance-recovery.service.ts`          | Continuation guards, passive-only selection, real-permit completion sweep and uncertain-DB checkpoint refusal. |
| `server/src/worker/recovery-permit-config.ts`                | Production permit pool factory; now uses the dedicated bounded retirement adapter described below.             |
| `server/src/worker/worker.module.ts`                         | Opt-in maintenance provider, independently composed from API/asset modules.                                    |
| `server/src/worker/worker-runtime.ts`                        | Optional Redis-ready notification; synthetic handlers and scheduler repair preserved.                          |
| `server/src/worker/main.ts`                                  | Start metadata before Redis, supervised synthetic startup retry and coordinated bounded shutdown.              |
| `server/test/maintenance-delivery.maintenance-spec.ts`       | Forced lock ordering, runtime/security/failure cases and real process tests.                                   |
| `server/test/helpers/maintenance-child.mjs`                  | Ownership-verified disposable process fixture; explicit synthetic storage evidence/operator reader.            |
| `.github/workflows/m13a-worker-ci.yml`                       | Adds the existing combined disposable command sequentially, without replacing any check.                       |
| `docs/development/milestone-13b3-report.md`                  | This consolidated report.                                                                                      |

The other cumulative changes belong to reviewed Slices 1–3. No dependency, lockfile, schema, migration, inspector, API, M12 executor or storage provider changed in Slice 4. Earlier phase reports remain byte-identical.

## Production composition and authorization

Maintenance is **off by default**. `SAEFR_MAINTENANCE_ENABLED=true` opts into passive metadata only. It requires explicit `MAINTENANCE_POSTGRES_HOST`, `PORT`, `DB`, `USER`, `PASSWORD`; no application credentials or `.env` fallback exists. Host/port/database must match the explicit `RECOVERY_PERMIT_POSTGRES_*` target. Writer and inspection roles may use different credentials. Deployments must grant narrowly scoped metadata privileges; configuration does not automatically provision roles.

The actual B.2 factory validates all dedicated permit settings and uses the protected runtime reader, exact M13 schema/history inspection and both storage roles. A startup success is never a reusable capability. Each tick observes the current permit generation afresh, and service boundaries repeatedly validate that exact generation before discovery, checkpoint, sweep and any separately invoked delivery work. Renewal also checks freshly and drops local ownership on denial or generation change. Permit/storage observations never occur under metadata row locks.

While disarmed, missing, untrusted, mismatched or unavailable, no reconciliation metadata writes or recovery enqueue are admitted. Local diagnostics remain available: state, bounded-shape progress counters, busy flags and whether this process believes it owns the coordinator. No diagnostic storage scan, receipt dump, filename, path, credential, permit value or ownership token is exposed. These diagnostics are observations, not a quiescence certificate.

**Production runtime always passes `delivery:false`.** Its disconnected delivery methods throw, and it constructs no recovery queue client. Only the pre-existing synthetic BullMQ handlers remain registered. No recovery consumer, automatic reservation, clearance issuer or destructive executor is connected. Redis-ready/reconnect notification wakes the same non-overlapping passive tick, which performs fresh permit checks; Redis cannot grant authority. Recovery delivery remains independently testable for later B.4 integration.

## Scheduling, fencing and transaction boundaries

| Setting                         | Default | Accepted range |
| ------------------------------- | ------- | -------------- |
| `SAEFR_MAINTENANCE_INTERVAL_MS` | 60000   | 1000–60000     |
| `SAEFR_MAINTENANCE_RENEW_MS`    | 10000   | 1000–10000     |
| `SAEFR_MAINTENANCE_BUDGET_MS`   | 20000   | 1000–20000     |
| `SAEFR_MAINTENANCE_SHUTDOWN_MS` | 8000    | 1000–10000     |
| `SAEFR_MAINTENANCE_PAGE_SIZE`   | 25      | 1–100          |

One tick and one renewal operation may be outstanding per runtime. Each tick processes at most one pending page and one completion-sweep page. The twenty-second default is a **new-operation admission budget**, not a promise to cancel already-issued database or filesystem work. Capacity is retained until the task settles; a hung tick is not replaced by another tick. Pools bound connection acquisition; the metadata writer has at most two connections, five-second server statement deadlines and seven-second client query deadlines. Server transaction-local lock/statement deadlines and synchronous commit remain enforced.

The existing PostgreSQL-clock lease remains sixty seconds. A sixty-second reconciliation cadence alone would be unsafe for renewal, so an independent timer renews at most every ten seconds. Timer punctuality is never authority: renewal rechecks token/epoch and PostgreSQL wall time after locking, cannot revive an expired identity, and stale mutations fail at their actual database boundary. A long event-loop stall or outage may lose leadership; the process then stops dependent progress rather than weakening fencing. An over-budget outstanding tick stops sustaining ownership.

Production discovery now locks **journal → retry → coordinator SHARE**, checks current ownership after waits, and repeats token/epoch/expiry in its INSERT predicate. It starts one full minute of eligibility delay without spending a budget. Existing standalone Slice 1 discovery and synthetic Slice 2 composition are preserved; they are not the new production path.

All generations, attempt counts and checkpoint values retain exact bigint or six-fractional-digit UTC text. Cursor read/rebind does not use JavaScript `Date`. Finite pass upper keys never expand during a pass; takeover resumes the same committed cursor/upper bound under a new owner epoch. Pending pass and completion-sweep cursors remain separate.

Unknown acquisition or renewal COMMIT cannot authorize work. The retained random token must be positively confirmed by a fresh database read before reuse. Unknown discovery/checkpoint/replacement results stop dependent progress. A positively aborted discovery lock timeout is an explicit safe deferral to the next finite pass, preserving later-row fairness without claiming discovery succeeded. Delivery-aware reconciliation now performs database coordination before advancing that receipt's cursor; Redis uncertainty can be deferred, but an unknown replacement COMMIT leaves the cursor unchanged. An absent or unavailable lookup never establishes rollback.

## Retry-state and journal status

| State/transition                                               | Implementation status                                                                                                                              |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing retry row → `due`                                      | Passive fenced discovery enabled only after live permit checks; counters start at zero.                                                            |
| `due`/`cooling` generation replacement                         | Reviewed database CAS and delivery orchestration exist; no production recovery delivery is admitted in this slice. Cooldowns/counters never reset. |
| `due`/`cooling` → `reserved`, confirmation, failure settlement | Slice 1 library primitives tested; **not called by production scheduling**.                                                                        |
| `blocked_admission` verification/release                       | Reviewed library primitive; not automatically invoked by this runtime.                                                                             |
| `reserved` → `blocked_execution`                               | Library retains attempt/incarnation/permit/journal-token evidence; production execution remains absent.                                            |
| Execution-block clearance/automatic takeover                   | **Deferred**. No clearance issuance, evidence fabrication or automatic release.                                                                    |
| Completed journal + passive `due`/`cooling` → `closed`         | Real-permit, coordinator-fenced bounded sweep; counters, errors and clearance history preserved.                                                   |
| Completed journal + reserved/blocked evidence                  | Preserved by the production sweep; the generic library method had the final-audit defect documented below and is now restricted to passive states. |

The journal alone establishes deletion authority/completion. Redis job state never does. No schema or M12 target tuple is changed, no new journal is accepted, and no physical deletion is initiated by this runtime.

## Startup, shutdown and recovery

Metadata starts before Redis readiness. With maintenance enabled, synthetic Redis startup failure is supervised one attempt at a time, with five-second delayed retry after confirmed cleanup; it cannot gate the PostgreSQL loop. Existing synthetic scheduler repair and processing remain intact. Without the opt-in, the original synthetic startup-failure behavior remains.

SIGTERM/SIGINT stop admission synchronously, clear timers, cancel deferred synthetic restart and invalidate local metadata ownership. Repeated requests share shutdown results. Nest module destruction invokes the same drain. No lease-release UPDATE is attempted; database-clock expiry governs metadata leadership. This is not execution takeover clearance.

Outstanding tick/renewal promises drain before resource closure. If the grace period expires, shutdown returns false and retains `incomplete`; late work cannot pass continuation checks to start another metadata/delivery operation. Already-submitted transactions may still commit, so checkpoints remain replayable and no cancellation guarantee is claimed. The existing process watchdog remains fifteen seconds and exits nonzero on incomplete shutdown/late handles. A process kill leaves durable state; a replacement uses a fresh coordinator identity and committed pass, not an assumption that an interrupted destructive call ended.

A real `pg_terminate_backend` probe exposed that checked-out clients can emit an error independently of `Pool`'s idle handler. Both the metadata writer and permit pairing pool now attach sanitized client-level handlers as well. Query rejections still flow into fail-closed repository/permit results; raw driver details are not logged. No unrelated API database handling was changed.

## Verification evidence — preceding permit-correction checkpoint

Commands run from the isolated worktree's `server/` under Node.js 24.22.0, with pinned existing dependencies. The results recorded before the separately authorized BullMQ correction were:

| Command/check                               | Actual completed evidence                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                             | Passed repeatedly; native helper compilation included, not native certification.                                     |
| `npm run typecheck` / `npm run lint`        | Passed after corrections; no final warnings.                                                                         |
| `npm run test`                              | **266 passed**, 27 files.                                                                                            |
| `npm run test:e2e`                          | **60 passed**, 8 files.                                                                                              |
| `npm run test:integration`                  | **348 passed**, 18 files; **6 native-storage cases skipped**, one file.                                              |
| `npm run test:migrations`                   | **106 passed**, one file; overlaps full PostgreSQL coverage.                                                         |
| `npm run test:redis`                        | **24 passed**, two files.                                                                                            |
| `npm run test:maintenance`                  | **54 passed**, two files, including nine additional real-transport/production-listener cases; no unhandled errors.   |
| `npm run test:runtime-smoke`                | Passed invalid-config and unavailable-auth-database safe exits.                                                      |
| Nested runner SIGTERM / SIGINT probes       | Both passed: expected nonzero exit 1, both owned cleanup confirmations and independent missing-container checks.     |
| Focused Prettier                            | Passed for all cumulative B.3 source, test, workflow and report changes.                                             |
| Markdown links / whitespace                 | Local links in all four B.3 reports resolve; complete tracked/untracked contents passed whitespace checks.           |
| Patch applicability                         | Forward/reverse check-only results and artifact identities are supplied in the final handoff; no Git index mutation. |
| Receive-deadline negative control           | Intentional failure at `still-pending` after six seconds when only the deadline was removed in a temporary copy.     |
| Extra production-startup/SIGINT repetition  | **18/20 passed; 2 failed** with a confirmed late BullMQ initialization error; unresolved, as detailed below.         |
| Hosted CI / native power-loss certification | **NOT RUN**. No push or PR is authorized.                                                                            |

New cases cover forced replacement/reservation order on independent backends; real lease renewal/loss and mid-page replacement; committed-but-unacknowledged ownership confirmation; actual backend termination/reconnect and disarm; unknown generation COMMIT without checkpoint progress; Redis reconnect while disarmed; no overlap and admission budget expiry; module destruction, repeated shutdown and incomplete drain; real child SIGTERM/SIGKILL and persisted-pass resumption; unchanged journal authority and zero automatic reservations/executor calls. Positive permit/process fixtures explicitly use the B.2 operator reader and synthetic physical observer under the test UID. The real production composition is also spawned with unavailable Redis and denies the test UID's untrusted runtime permit identity. No production permissive fallback exists, but positive native-profile deployment composition is not certified by these fixtures.

The Slice 3 LOW correction holds the journal on a third connection, observes each independent backend waiting in PostgreSQL, orders both contenders, and checks exact winner/loser results, generation, reservation tuple, counters and replay refusal. A temporary-copy mutation removed the replacement's post-lock eligibility/revision checks and their SQL predicates. The reservation-winning test then failed at the intended assertion (`ok` instead of `stale`); no reviewed source was weakened. Initial mutation probes also exposed cached `pg_stat_activity` observations within the holder transaction, so both lock-wait probes now call `pg_stat_clear_snapshot()` before observing backend waits. The focused intentional-failure rerun reached the actual stale-result assertion. These mutation failures are expected negative evidence, not passing verification suites.

Earlier unsuccessful checks are not counted as passes: initial TypeScript checks found test/result narrowing issues; one fake-clock assertion failed because Node's monotonic clock needed explicit control. A combined run passed 41/42 cases before fenced production discovery was added. Backend-termination runs passed their individual cases but exited nonzero for an uncaught client error; adding only an idle-pool listener was insufficient, and the checked-out client handling above resolved it. The successful 44-case run had no unhandled errors. A later full Redis run passed 23/24 cases but missed the existing late-handle fixture marker within its five-second wait. The complete unchanged 24-case suite passed on rerun; the test was not relaxed. Its precise transient timing cause is unproven, so this is retained as a shutdown-test precision limitation rather than presented as first-attempt success. All these runners removed their owned containers. The final PostgreSQL and Redis ownership-label listings were empty. The final combined suite also includes the forty-fifth real-lock fairness case added after the earlier 44-case success.

## Hosted readiness, operational limitations and review gate

The existing Ubuntu 24.04 / Node.js 24 workflow adds `npm run test:maintenance` as a sequential fifteen-minute step. Its permissions, credential-free checkout, existing suites, disposable ownership guards and overall timeout remain intact. Command behavior is locally exercised; actual hosted timing, cancellation and positive native storage evidence await an authorized PR run. No CI success is claimed.

- M13B.4 must independently bind each real execution to current retry generation/attempt/incarnation, live permit and M12 claim at every required provider boundary; prove aggregate capacity and conservative takeover/quiescence before connecting a destructive consumer.
- No automatic Trash expiry, scanner, orphan cleanup, receipt purge, clearance issuance or new HTTP operation was added.
- PostgreSQL, Redis and external permits cannot commit atomically. A hint may survive disarm; it remains non-authoritative. The producer's uncertainty quarantine and retained-job/cooldown semantics remain unchanged.
- Native filesystem/OS permissions, backup restoration, power loss, multiple-process resource budgets, TLS and public deployment are not certified. Existing dependency advisories remain follow-up work.
- Development PostgreSQL, real media, existing markers and persistent Docker volumes were not used. Disposable fixtures use verified random identities/credentials, localhost ports and tmpfs; process fixtures reverify before connecting. SIGKILL/host failure can defeat in-process container cleanup; no broad prune is used.
- Historical migration/inspector/ADR and earlier report evidence is unchanged. Approval of this implementation is not deployment, real-data migration, B.4, commit, push, PR or merge authorization.

Repeat from `server/`: `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test`, `npm run test:e2e`, `npm run test:integration`, `npm run test:migrations`, `npm run test:redis`, `npm run test:maintenance`, `npm run test:runtime-smoke`. Database/Redis commands must use their owned disposable runners. Do not substitute regular application credentials or run operator commands.

Incremental Slice 4 and complete cumulative patches include untracked contents/modes, forward/reverse check-only applicability, sizes/hashes and an exact manifest outside the repository. The baseline artifacts are preserved. The independent Slice 4 review returned FAIL, as recorded below. Focused re-review of this correction and a final M13B.3 milestone audit remain required; nothing is self-approved.

## Permit corrective pass after independent Slice 4 FAIL

The verified pre-correction worktree had eight tracked modifications, twenty-six untracked files and an empty index at the same HEAD. Its complete patch matched the reviewed artifact exactly: 311,125 bytes, SHA-256 `ea40ff5b46da32c240af41c5787e688b5671d3ea2757fb532c7ee059ebac91c6`. That artifact and Slices 1–3 evidence remain unchanged. That permit correction changed eight paths relative to that snapshot:

| File                                                   | Corrective scope                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `server/src/worker/permit-database-pool.ts`            | New dedicated Kysely/pg adapter: client receive deadlines, destroy-release, quarantine and independently confirmed remote-session absence. |
| `server/src/worker/recovery-permit-config.ts`          | Factory uses the adapter, bounded idempotent close and count-only database diagnostics.                                                    |
| `server/src/worker/maintenance-runtime.ts`             | Unavailable authorization reports degraded, loses local ownership and cannot resume after stop or expired admission.                       |
| `server/test/helpers/postgres-fault-proxy.ts`          | Owned disposable PostgreSQL-only authenticated reply-blackhole fixture; separately faults absence-proof traffic.                           |
| `server/test/helpers/permit-pool-child.mjs`            | Actual production checked-out listener probe, isolated from the runner process.                                                            |
| `server/test/permit-database.maintenance-spec.ts`      | Nine successful/error/blackhole/recovery/shutdown/listener cases.                                                                          |
| `server/test/maintenance-delivery.maintenance-spec.ts` | Precise degraded-versus-blocked assertions and redacted production-child shutdown diagnostics; existing safety assertions retained.        |
| `docs/development/milestone-13b3-report.md`            | Findings, correction and actual verification evidence.                                                                                     |

### MEDIUM — bounded receive and genuine connection retirement

The independent reviewer confirmed that authentication could finish and later PostgreSQL replies disappear indefinitely. Server statement/lock timeouts and a JavaScript admission budget do not bound receipt of their responses. The former pool could leave `authorization.observe()` pending and retain the session-level migration advisory lock. The original implementation is therefore **not approved** by its earlier passing tests.

The installed dependencies inspected were `pg` **8.23.1** and `pg-pool` **3.14.0**. The new dedicated read-only adapter retains a single primary connection and disables pipelining. Connection establishment and pool checkout are bounded at **2 seconds**, each primary SQL receive at **3 seconds**, local disposal acknowledgement at **1 second**, and an independent absence-proof SQL receive at **2 seconds**. The proof connection also has a two-second connect bound. These are fixed production limits, not shorter test-only settings. The existing five-second server statement/two-second lock limits remain defense in depth. Per-query limits do not promise a three-second end-to-end schema inspection; the overall runtime budget still controls admission of new work.

A receive timeout first marks the exact client unusable, records uncertainty and invokes the supported `PoolClient.release(true)` destroy-release. In the installed non-pipelined client this ends/destroys the active connection. Any query/transport error takes the same conservative path. Kysely's later release cannot recycle or double-release it; subsequent wrapper queries and late successful callbacks are refused. Disposal acknowledgement is tracked from the actual client's `end` event, with a bounded wait. The adapter's close promise is shared, including failure, so a second shutdown does not turn a previously incomplete result into success. No library or shared historical migration implementation changed. See the [pg pool destroy-release contract](https://node-postgres.com/apis/pool) and [client API](https://node-postgres.com/apis/client); the installed source was also inspected.

**Local closure is not remote quiescence.** Before caller SQL, each new primary session records its PID and exact `backend_start`, together with an instance-specific random application name. After retirement, an independent read-only connection must positively observe that exact session absent from `pg_stat_activity`; the fallback before identity receipt uses that instance's unique application name, and no caller/advisory SQL has yet been submitted. The proof connection must itself finish local disposal before quarantine clears. If the old backend remains, proof cannot be received, or local disposal is unknown, no fresh primary validation is admitted. No production backend-termination command is issued. A restored connection must repeat full B.2 schema/history, storage and generation validation; absence proof alone grants no authority.

Normal migration inspection still unlocks in `finally`. When an advisory-lock acquisition/reply or unlock fails, the retired wrapper cannot submit further SQL or return to the pool. Tests independently observe the retained lock while the proxy preserves the remote session, then positively observe availability after only that proxy-owned backend connection is closed. Bounded runtime ticks become degraded, retain no coordinator ownership, and do not spend attempts or advance pages. Repeated ticks share in-flight work. Late old responses cannot resume it. Shutdown returns incomplete if remote absence cannot be established, even when the local socket closed.

This mechanism assumes a **direct, session-affine PostgreSQL 18 endpoint** with visible own-session identity. A transaction pooler, arbitrary rerouting proxy, restored/replaced server or unsupported network topology cannot use a read from another server as quiescence evidence. A partition may require waiting for PostgreSQL to observe the closed connection or separately reviewed operator fencing. There is no automatic killing of unrelated sessions, restoration detector, destructive takeover clearance or distributed I/O cancellation. Event-loop starvation and OS failures can delay JavaScript timers; the existing process watchdog remains the outer fallback.

### Real transport regression and LOW listener coverage

The local proxy completes real authentication and then discards primary SQL replies, either before identity receipt or after identity and advisory-lock acquisition. It can preserve the upstream backend after local client closure and independently blackhole proof replies. Its target is derived only from the ownership-verified random PostgreSQL 18 runner, never ordinary application credentials. Native storage is not involved: positive runtime tests use the explicit synthetic observer/operator reader already established in B.2 tests; the actual factory blackhole test fails before any media verification.

The new cases prove successful schema inspection/unlock, refused connection, server statement timeout, client receive timeout through actual `createPermitPairing`, non-reuse, explicit uncertainty, independent proof failure, fresh passive recovery, zero automatic attempts/clearances, non-overlap, late-response refusal and truthful repeated shutdown. The factory test has a separate six-second assertion guard so removing the production deadline yields an explicit `still-pending` failure, not a whole-test timeout. A temporary-copy mutation removing only the receive deadline failed at that exact assertion after six seconds (one intentional failure, eight unselected cases), and its runners removed both containers. The first mutation probe was inconclusive because cleanup masked the assertion; the test now compares the typed failure code and preserves assertion failure during cleanup, while still requiring successful repeated close on its positive path.

The earlier test-owned listener test remains historical integration coverage but is no longer the evidence for the LOW finding. New isolated children instantiate the **same production adapter used by the factory**, check out its client and receive controlled termination of only their verified disposable backend. No test-owned client error listener is installed. The intact production listener handles retirement and permits fresh validation; a temporary-copy mutation removing that listener makes Node terminate with an unhandled error, which the parent explicitly asserts. Reviewed production code is never weakened to run this negative control.

### Corrective verification and failures

The verification table above records the corrective full-suite results, including 54 combined cases (the prior 45 plus nine). Migration-only cases overlap the full PostgreSQL suite. No hosted CI or native power-loss certification was performed.

The first corrective typecheck found an excess `max` property in a standalone `Client` configuration; it was removed and typecheck passed. Two early combined runs passed **53/54** but exceeded the twenty-second case deadline during restored-connectivity validation. Sanitized stage tracing localized the delay to the proxy's positive-response path. Disabling TCP Nagle buffering on both proxy sockets removed per-frame delayed-ACK amplification during many sequential catalog queries. Production deadlines, assertion strength and test timeout were not increased. The combined suite then passed all 54. After adding the explicit assertion guard, one later full run passed all nine permit cases but failed the existing production-startup/SIGINT case (53/54 overall). Redacted diagnostic capture was added without changing its exit assertion, and the final complete combined run passed 54/54. The additional repetition probe below established a genuine separate failure rather than dismissing it as timing noise. Initial focused formatting differences were corrected. These unsuccessful runs are not counted as successes. The pre-existing intermittent Redis late-handle marker observation above remains unresolved and was not relaxed or attributed to this transport fix.

Correction-only and cumulative review patches, exact manifests, byte sizes, hashes and forward/reverse check-only results are supplied in the external handoff. HEAD remains unchanged and the Git index remains empty. Historical migrations, inspectors, API/authentication/storage behavior, retry budgets/cooldowns and earlier slice reports remain unchanged. Production is still disabled by default and passive-only when enabled; B.4 remains disconnected. Focused independent re-review is required before any Git checkpoint.

### Historical additional finding — synthetic Redis early-shutdown race

A temporary-copy probe repeated the existing production passive-startup/unavailable-Redis/SIGINT case twenty times using the same built worker. **18 passed and 2 failed**, both exiting 1 with an unhandled `RedisConnection` error after `ECONNREFUSED`. This is separate from the earlier late-handle marker deadline, whose cause remains unproven. It is also separate from the permit receive defect: the production runtime reader rejects this fixture UID before permit database SQL, and at that checkpoint the synthetic worker, process main, module and metadata composition were byte-identical to the reviewed Slice 4 snapshot.

Inspection of installed BullMQ **5.81.5** identified the lifecycle window: `RedisConnection` attaches `initializing.catch(err => this.emit('error', err))`, while its initializing `close()` disconnects and removes all listeners before that rejection handler necessarily runs. The then-unchanged `WorkerRuntime.closeResources()` called `queue.close()` during cancellation of unavailable-Redis startup (`server/src/worker/worker-runtime.ts`, queue-close branch). This can produce the observed unhandled late error and raw driver diagnostic. No credential appeared in the captured fixture response. The probe's two owned containers were removed.

At the preceding checkpoint this was a confirmed unresolved shutdown/reliability concern (MEDIUM), not a passing probe or a permit bypass. No dependency patch, synthetic-worker change, global error suppression or weakened assertion was introduced in that pass. The maintainer subsequently authorized the focused lifecycle correction recorded below. The original failure evidence is preserved; independent re-review and the overall checkpoint gate remain open. The earlier, separate shutdown-marker precision observation remains unproven. No destructive execution or Git operation is authorized by these results.

## BullMQ startup/shutdown corrective pass — 2026-10-31

### Baseline integrity and reproduced mechanism

Before this pass, HEAD, branch and empty index were verified against the preceding 38-file manifest, including contents and modes. The 66,432-byte permit correction patch matched SHA-256 `21e52044b117c0b487bd7849af47dfc6c3b7cbf5fe5325b6b369af1ccfa2b90d`. The 366,246-byte cumulative patch reconstructed byte-for-byte and matched `f2bbf225618fcfdb8b5052603f05193ad755a77703d85b6de0d7b457520d3435`. All old artifacts and all 38 baseline contents were preserved outside the worktree. No implementation change preceded that verification.

The original real-process passive-startup/unavailable-Redis/SIGINT scenario was repeated twenty more times through the same disposable PostgreSQL/Redis runners before editing. **19 passed and 1 failed** with the same late `RedisConnection` initialization error. This supplements the original **18/20** observation; neither passing repetitions nor frequency establish safety.

A deterministic child used the installed BullMQ **5.81.5**, actual production `WorkerRuntime` and BullMQ's supported `clientFactory` seam to hold only driver events at barriers. The seam exists solely in the isolated child. Structured evidence showed:

1. Queue initialization began and recorded a controlled driver error.
2. Shutdown synchronously requested disconnect.
3. The old production lifecycle returned `true` and `stopped` **before** the held transport-end event.
4. Releasing that event rejected initialization after BullMQ had removed error listeners, causing an unhandled `RedisConnection` error and process exit 1.

An equivalent barrier reproduced the listener-removal problem in the consumer's base/blocking initialization. **Classification: confirmed production lifecycle defect interacting with dependency close semantics**, not a marker-only or container-timing failure. Installed ioredis **5.11.1** source also explains a distinct cancellation edge: disconnecting during reconnect backoff may clear the retry timer without ever settling BullMQ's original readiness promise. A real-driver probe and existing unavailable-Redis tests exposed that edge during the first correction attempt.

### Exact correction and lifecycle contract

- `InitializationSafeRedisConnection` is injected through BullMQ's existing Queue constructor seam for the synthetic producer and the already-existing library-only recovery producer. There is no dependency edit or global prototype/error handler. A close task is cached per connection.
- For partial initialization, the adapter waits for initialization to settle and the owned driver to acknowledge `end` **before** BullMQ removes its error forwarding. Cancellation rejection still reaches the existing sanitized queue handler and startup rejection path; it is not reclassified as successful startup.
- If already waiting to reconnect, stopping that timer can strand initialization. The adapter changes only that owned client's close-time retry strategy to refuse further retries, lets the single previously scheduled attempt reach an error/end or connect, and disconnects on connect. This can create a transport for that already-scheduled attempt; it creates no new Queue, Worker, producer or consumer. Caller admission stays fenced. No authentication-before-connect guarantee is claimed.
- The synthetic queue's initialization-close bound is **5 seconds**, derived from the existing maximum two-second reconnect backoff plus two-second connect timeout plus a one-second disposal allowance. Already-initialized queue close remains two seconds. Existing fallback waits, active-processor drain and the fifteen-second process watchdog remain bounded. A timeout still returns incomplete; no fabricated end event, manual status assignment, private retry-timer access, polling or sleep is used in production.
- BullMQ constructs its blocking consumer connection internally. `WorkerRuntime` records its public `waitUntilReady()` promise and requires positive readiness before library teardown. A failed or unconfirmed initialization returns bounded `false`/`incomplete`, retains resource references and exposes `consumerInitializationConfirmed:false`. Supervised process termination is required in that case. This conservatively avoids calling the unsafe dependency teardown on an unknown consumer; it does not promise graceful cancellation of every partial consumer connection.
- `stop()` now installs the admission fence even when called before any resource exists. Late readiness cannot pass `requireStarting()`, create a new consumer, register a control loop, resume producer replacement or grant metadata/recovery authority.
- The existing recovery producer caches its `closing` promise before awaiting connection disposal, preventing its constructor metadata continuation from treating the queue as open. Production recovery delivery remains disconnected; the change does not enable a recovery consumer or reservation.
- Production main retains SIGTERM/SIGINT handlers with `process.on`, so repeat signals reach the same cached shutdown promise rather than falling back to default signal termination. No signal handler creates a second watchdog or resource drain. Event listeners alone do not keep Node alive.

The adapter is scoped to the owned standalone connections created here, and relies on the inspected pinned dependency behavior. Upgrades must rerun its real-driver and deterministic lifecycle regressions. The resource-close bounds are local acknowledgements, not proof of remote filesystem or database quiescence. Existing unsupported-topology and controlled-restoration requirements are unchanged.

### Source and test manifest relative to the 38-file baseline

| File                                                        | This correction                                                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `server/src/worker/initialization-safe-redis-connection.ts` | New initialization/end drain and close-time retry fencing adapter.                                                            |
| `server/src/worker/worker-runtime.ts`                       | Injection, exact producer-readiness tracking, pre-start fence, confirmed consumer readiness and bounded conservative cleanup. |
| `server/src/worker/redis-recovery-delivery.ts`              | Same safe producer connection and idempotent closing fence; remains library-only.                                             |
| `server/src/worker/main.ts`                                 | Retained signal handlers; existing cached shutdown, watchdog and maintenance boundaries preserved.                            |
| `server/src/worker/worker-runtime.spec.ts`                  | Two pre-initialization cancellation unit tests.                                                                               |
| `server/test/helpers/worker-initialization-child.mjs`       | Controlled driver barriers around real BullMQ and production runtime.                                                         |
| `server/test/helpers/worker-startup-signal-driver.mjs`      | Child-only IPC disposal barrier for actual production main; no test-owned signal handler.                                     |
| `server/test/worker-lifecycle.redis-spec.ts`                | Lifecycle assertions, original Queue negative control, real main repeat signals and original signal-handler negative control. |
| `docs/development/milestone-13b3-report.md`                 | Evidence, correction, limitations and final handoff.                                                                          |

The cumulative review set is now **43 files: eight tracked modifications and thirty-five untracked additions**. Only the nine paths above differ from the verified 38-file checkpoint. All permit correction files and existing maintenance/marker tests remain byte-identical. No migration, inspector, durable automatic-recovery retry policy/budget/cooldown, coordinator mutation, API/authentication/storage implementation, dependency or lockfile changed in this pass. The owned Redis close-time retry fence is described above.

### Regression sensitivity and intermediate failures

Controlled cases cover stop before construction, failed initialization, reconnect backoff, late readiness, concurrent stops, successful consumer initialization during drain, initialization immediately before stop, consumer failure, initializer/end acknowledgements that never arrive, and the existing recovery producer. Success requires transport-end evidence **before** test fixture cleanup. Unconfirmed cases must return incomplete within the supported bound, and late fixture release must not rewrite that result. No consumer may be created after a pre-consumer fence. These are production lifecycle methods with a synthetic driver, not mocked shutdown promises or real storage claims.

A temporary-copy mutation removes only the safe Queue connection argument. The original unhandled initialization-error exit must be observed (exit **1**, with the expected emission), not a child watchdog timeout. A second temporary-copy mutation restores `process.once` in actual main. The IPC test holds disposal, sends the same signal twice plus the other shutdown signal, and requires the unsafe control to terminate specifically by **SIGTERM**, never a watchdog SIGKILL. Positive main cases require natural exit 0, no ready marker after cancellation, and no private driver error. No reviewed source is modified to run these negative controls.

Failures were retained rather than counted as passes. An early typecheck found nullable child pipes in the new IPC test; explicit pipe checks corrected it. A standalone probe was first launched from the repository root instead of `server/` and could not resolve its compiled module; it was rerun from the required directory. A controlled driver's transport-end assertion initially conflated BullMQ's writable `status` with a genuine event; independent end counting fixed the fixture, and disposal is asserted before synthetic cleanup. The first unsafe-Queue mutation probe stopped at a premature-completion assertion instead of the intended late error; moving that assertion after the event-turn barrier exposed the actual dependency error.

The first complete Redis run after the initial adapter attempt had **35/38 passing**: two existing unavailable-Redis startup/signal cases revealed the reconnect cancellation edge, and the initial mutation probe lacked the intended late-error evidence. The reconnect-specific close protocol above corrected the production issue without weakening those existing tests. The resulting suite passed **39/39** (the extra case explicitly exercises reconnect backoff). Later fixture refinements pin fallback configuration to loopback port 1 and require exact negative-control exit causes, so a lost test seam or watchdog cannot masquerade as success. Final verification below uses those refinements.

The old `worker-late-handle.cjs` beforeExit marker fixture and its assertions are unchanged. Production has no shutdown-marker protocol or beforeExit dependency. The newly proven unavailable-Redis initialization defect does not establish the cause of the earlier five-second marker miss after an already-ready worker; that separate precision observation remains documented.

### Latest verification and remaining gates

Final commands were executed from the isolated worktree's `server/` under Node.js 24.22.0. The disposable database/Redis suites ran sequentially through the established owned runners.

| Command/check                                         | Latest actual result                                                                                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                                       | Passed, including native helper compilation; not native certification.                                                                                      |
| `npm run typecheck` / `npm run lint`                  | Passed on final source and tightened fixtures.                                                                                                              |
| Focused pre-start unit file                           | **2/2 passed**.                                                                                                                                             |
| `npm run test`                                        | **268 passed**, 28 files; rerun after loopback-only fixture refinement and passed again.                                                                    |
| `npm run test:e2e`                                    | **60 passed**, 8 files.                                                                                                                                     |
| `npm run test:integration`                            | **348 passed**, 18 files; **6 native-storage cases skipped** in one file.                                                                                   |
| `npm run test:migrations`                             | **106 passed**, one file; overlaps the full PostgreSQL suite.                                                                                               |
| `npm run test:redis`                                  | **39 passed**, three files, twice after the reconnect correction; final run includes the exact-exit negative-control and loopback-only fixture refinements. |
| `npm run test:maintenance`                            | **54 passed**, two files; includes all nine actual permit connection/blackhole/listener regressions and prior runtime/fencing/race cases.                   |
| `npm run test:runtime-smoke`                          | Passed invalid-configuration and unavailable-authentication-database safe exits.                                                                            |
| Nested runner SIGTERM / SIGINT probes                 | Both passed: expected exit 1 and both owned containers independently confirmed absent.                                                                      |
| Formatting, links and complete-content whitespace     | Passed for all 43 cumulative files and eight local Markdown references; final report/patch checks repeated at handoff.                                      |
| Hosted CI / native-storage / power-loss certification | **NOT RUN**; no push, PR or certification is authorized.                                                                                                    |

The post-correction repetition of the original production passive-startup/unavailable-Redis/SIGINT scenario passed **20/20** in the temporary-copy probe, with forty-four unrelated cases unselected. The unchanged original test body spawned the newly built production main. This follows the original **18/20** observation and this pass's pre-correction **19/20** reproduction. The probe's owned PostgreSQL/Redis containers were removed. Passing repetitions are additional observations, not proof of all shutdown interleavings; the deterministic event ordering and temporary-copy negative controls provide regression sensitivity. Final ownership-label listings were empty for both test runners. No required local check was left unrun.

The PostgreSQL receive-deadline/retirement/uncertainty logic and production listener controls remain byte-identical to the verified 38-file checkpoint and passed the complete combined suite again. Old artifacts, historical reports, migrations and inspectors are preserved. Final manifests and correction-only/cumulative patches include all contents and modes, with forward/reverse check-only validation and exact identities supplied outside the repository.

Remaining limits include supervised nonzero termination when consumer readiness or disposal cannot be confirmed; dependency-version sensitivity of this local compatibility adapter; the prior unproven marker-timing observation; unsupported network/platform/storage profiles; and unverified deployment, native durability and multi-process budgets. BullMQ/ioredis can leave late non-working timers; the existing process watchdog remains active through component cleanup and requires actual process termination rather than treating a component `stop()` result as global event-loop quiescence. Local component closure is not remote filesystem/database quiescence or permission for execution takeover. The controlled driver proves specific orderings, not every possible interleaving. No hosted CI, storage certification or power-loss result is claimed.

Production maintenance stays disabled by default and passive-only when enabled. No automatic recovery consumer, reservation, destructive executor, clearance issuer or M13B.4 integration is authorized or connected. Existing dependency-audit advisories remain follow-up work. Independent review remains required; this report does not approve itself or authorize a Git checkpoint.

## Three-MEDIUM lifecycle remediation — 2026-10-31

### Independent FAIL and preserved baseline

The focused independent re-review returned **FAIL**. It independently verified the PostgreSQL permit MEDIUM and production-listener LOW as fixed, but confirmed three blocking MEDIUM BullMQ lifecycle defects. Its complete Redis run hung and was interrupted; that run is not a pass. Its separate 54-case maintenance suite and two focused unit cases passed. This section supersedes the earlier lifecycle-safety conclusion, without rewriting the historical results above. The final comprehensive M13B.3 audit and any Git checkpoint remain gated on independent re-review.

Before this remediation, the branch was `feat/m13b3-runtime-reconciliation`, HEAD `8ef39c835fa0c18a31cfe63a6ae63b645427f201`, index empty, with eight modified tracked files and thirty-five additions. The 410,351-byte cumulative patch matched SHA-256 `ab9695e5dcc93f2b1ca42bd8427c60affc471957c1add2fbb3104b124cf253d5` byte-for-byte, including modes and the complete 43-file manifest. Forward/reverse check-only applicability passed. A separate external snapshot preserves all baseline files; no prior artifact was overwritten.

### Installed-library ordering map

The inspected versions remain BullMQ **5.81.5** and ioredis **5.11.1**, with no dependency changes. `pause(true)` sets the local pause flag but does not drain the fetch/scheduler continuation or complete worker loop. Forced `Worker.close(true)` skips the loop drain. BullMQ's scheduler retry defaults to unlimited retries and skips its delay after closing; closing its essential transport under a pending continuation can create a non-yielding retry loop. `Worker.close()` also catches component cleanup failures, emits `error`, and may resolve. Finally, forced `RedisConnection.close()` calls void `disconnect()`, can assign driver status `end`, and removes listeners without waiting for genuine socket termination. ioredis disconnect initiates a half-close; its real end event follows transport retirement. These are version-sensitive local lifecycle contracts, not remote outcome or filesystem-quiescence guarantees.

### Corrections

1. **M1 — scheduler/full-loop drain:** shutdown fences admission synchronously and uses public `pause(false)`, then confirms the whole `runTask`, including fetch/scheduler continuations, before consumer teardown. The draining pause interrupts the dedicated blocking read while retaining the essential base connection. It can reconnect that same paused blocker after draining; it creates no new Worker or authorized processor. If that operation or loop cannot settle within the five-second drain budget, shutdown returns `false`/`incomplete` and retains the essential base transport and listeners; it does not force-close them under the pending retry. A late processor is rejected before invoking the synthetic handler. Control-tick continuations recheck shutdown before new scheduler repair or healthy-state publication. Already-started BullMQ internal scheduler work may finish against the retained connection; it cannot create application/recovery authority. Incomplete cleanup requires supervised termination; arbitrary network partitions cannot be gracefully canceled in process.
2. **M2 — positive producer retirement:** the existing connection adapter now requires actual driver-end evidence for both initialized and initializing connections, before library listener removal/status mutation. Initialization settlement and the existing close-time reconnect fence are preserved. Synthetic producer replacement uses this same evidence rather than reading a library-mutated status. Recovery delivery retains quarantine and capacity after a disposal timeout. Only positive retirement plus old-command settlement may release the queue, including late evidence; no replacement is admitted while either remains unknown. Cached close promises remain idempotent. Local retirement does not determine whether a timed-out Redis command executed; delivery still reports uncertainty and future reconciliation re-reads authoritative state.
3. **M3 — truthful aggregate cleanup:** worker errors during shutdown set a sticky cleanup-failure flag, independent of normal degradation. Before teardown, the runtime observes the real end events of both ready consumer clients. Temporary production error forwarding remains until each ends, including when BullMQ removes its own listeners. A swallowed cleanup error, absent end acknowledgement, active loop/processor or pending producer leaves shutdown incomplete. Repeated stops share that same result; late end events cannot rewrite it to success.

No PostgreSQL permit adapter, production PostgreSQL listener, permit-generation check, coordinator/retry repository, lock order, exact timestamp handling, migration, dependency, authentication or storage implementation changed. Production maintenance remains disabled by default and passive-only when enabled. Recovery producers remain disconnected, automatic reservations disabled, and no destructive consumer/executor or automatic takeover clearance is connected.

### Regression sensitivity and failures retained

- A real-Redis child holds the worker's actual scheduler continuation before its next scheduling operation. Public `runtime.stop()` must settle incomplete **without closing the consumer**, and releasing the barrier afterward must drain without invoking the application handler. A temporary compiled-copy negative control restores close-before-drain and must reach the exact vulnerable phases before the independent parent kills its non-yielding loop. A missing phase or unrelated early exit is a failure, not a successful negative control.
- A real TCP proxy permits a producer half-close while retaining the socket. A real Redis read followed by a synthetic lost acknowledgement enters the production disposal path immediately. The adapter must refuse replacement until an actual end event; releasing the proxy then permits a new producer. A test-only control invokes the original initialized BullMQ close path and detects premature replacement. Neither path mocks a resolved disposal promise.
- Controlled production-runtime children inject an initialized blocking-client disconnect failure or retain its end acknowledgement. They require `false`/`incomplete`, real event counts before fixture cleanup, and the same result from repeated stops and after late fixture release. A temporary-copy negative control removes the completion guards and must fail the false-clean assertion. Existing initialization, missing-end and repeated-signal controls remain active.
- The old externally-stopped-consumer fixture now uses `close(false)`: its purpose is to test degraded health after an external consumer stop, not to force-close underneath the dependency's live scheduler continuation. Dedicated new public-runtime tests preserve coverage of the unsafe forced-close ordering.
- The first focused run passed **21/22**. The half-close fixture initially allowed the real command timeout to consume four seconds, so ioredis's existing socket timeout retired it before the expected held-end assertion. The fixture was corrected to lose the acknowledgement immediately after a real read; timeout values and production assertions were not weakened. The final focused run passed **22/22**.
- The first complete Redis run passed **43/46**, with three failures: clean stop after silent-command recovery, the concurrency/graceful-stop test's five-second deadline, and ready-process SIGTERM exit status. Waiting for a natural paused-loop drain was insufficient: installed BullMQ can block delayed-job reads for ten seconds irrespective of `drainDelay`. That attempt was replaced with the public draining `pause(false)` operation; no read-delay override remains. The original assertions and timeouts were preserved. The focused tests were rerun after the correction.
- Initial lint reported four deliberate unbound-method warnings in child-only wrappers. Narrow comments document that each saved dependency method is explicitly applied to its original receiver; the subsequent complete lint passed without warnings. Two build invocations from the repository root failed because npm scripts belong in `server/`; the actual server builds passed. An initial external stress-harness generation assertion stopped before execution and was corrected outside the repository.

### Current verification

Final verification results and artifact identities are recorded below after the sequential checks complete. The previous 18/20 and 19/20 unavailable-Redis startup failures, subsequent 20/20 observation, and unrelated five-second late-handle marker miss remain historical evidence. This remediation does not establish the cause of that marker miss. Repetition results supplement deterministic controls and do not prove all shutdown interleavings.

Final source verification ran under Node.js **24.22.0**, sequentially from this worktree's `server/`. Each complete command had an external ten-minute timeout and twenty-five-second termination allowance. Potentially non-yielding negative controls ran in separate children with an independent twelve-second parent deadline; their expected termination is not counted as a successful graceful shutdown.

| Command/check                           | Final actual result                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`                         | Passed; native helper compiled, not native certification.                                                                             |
| `npm run typecheck`                     | Passed.                                                                                                                               |
| `npm run lint`                          | Passed without warnings.                                                                                                              |
| `npm run test`                          | **268 passed**, 28 files.                                                                                                             |
| `npm run test:e2e`                      | **60 passed**, 8 files.                                                                                                               |
| `npm run test:integration`              | **348 passed**, 18 files; **6 native-storage cases skipped** in one file.                                                             |
| `npm run test:migrations`               | **106 passed**; these cases overlap the full PostgreSQL suite.                                                                        |
| `npm run test:redis`                    | **46 passed**, four files; includes scheduler, real-TCP, consumer-error and repeated-signal controls.                                 |
| `npm run test:maintenance`              | **54 passed**, two files, including actual permit reply-blackhole and production-listener positive/negative controls.                 |
| `npm run test:runtime-smoke`            | Passed invalid-configuration and unavailable-authentication-database safe nonzero exits.                                              |
| Focused lifecycle runner                | **22 passed** after the draining-pause refinement; external copy only filters the unchanged owned Redis runner's test file arguments. |
| Hosted CI / native storage / power loss | **NOT RUN**; no result is claimed.                                                                                                    |

### Corrective manifest and review boundary

This remediation changes exactly nine files relative to the verified checkpoint:

- `server/src/worker/worker-runtime.ts`
- `server/src/worker/initialization-safe-redis-connection.ts`
- `server/src/worker/redis-recovery-delivery.ts`
- `server/test/helpers/worker-initialization-child.mjs`
- `server/test/helpers/worker-scheduler-drain-child.mjs` (new)
- `server/test/worker-lifecycle.redis-spec.ts`
- `server/test/worker-shutdown.redis-spec.ts` (new)
- `server/test/worker.redis-spec.ts` (previously clean at HEAD)
- `docs/development/milestone-13b3-report.md`

The complete cumulative M13B.3 review set is **46 files: nine tracked modifications and thirty-seven additions**. The prior 43-file set is preserved, plus the two new regression files and the existing Redis fixture modification. All other prior file contents remain unchanged. Earlier permit and production-listener corrections, passive wiring, database repositories, workflow and disposable runners are byte-identical to the verified baseline. No new migration, dependency, runtime configuration, production recovery reservation or destructive authority is introduced.

Correction-only and cumulative patches, exact mode/content manifests, byte sizes and SHA-256 identities are supplied externally with the handoff. Their check-only forward/reverse verification and complete-content whitespace checks are required before handoff; no index write is involved. Earlier review patches remain untouched. The implementation remains unstaged and uncommitted at the same HEAD, awaiting focused independent re-review. Passing tests and this report do not self-approve the three findings.

Remaining limits: no unconditional in-process cancellation under arbitrary partitions, no inference of remote Redis outcome from local termination, version-sensitive BullMQ/ioredis behavior, supervised termination for incomplete consumers, the unproven historical marker-timing observation, outstanding dependency audit advisories, and unverified deployment, native durability and power-loss behavior. No development database, real media, storage marker, persistent volume or original checkout was modified. B.4 automatic execution remains unimplemented and disconnected.

Supplementary stress used an external copy of the unchanged owned PostgreSQL/Redis runners and the existing passive-startup/unavailable-Redis/SIGINT test expanded to twenty cases, with 0–3 ms variation before signalling. **20/20 passed**, **zero unexpected timeouts/hangs**, with forty-four unrelated cases excluded. All twenty required natural exit 0 and retained the credential/path-redaction assertions. The deliberately hung close-before-drain negative control is separately supervised and is not included in this stress success count. Its expected SIGKILL demonstrates regression sensitivity, not graceful termination. Both stress containers were removed.

Explicit nested-runner **SIGTERM and SIGINT interruption probes passed**: each returned the expected exit 1, and independent Docker inspection confirmed both of that run's exact owned containers absent. The first external probe parsed only the PostgreSQL name despite both cleanup messages, so it stopped at its own inventory assertion; that parser was corrected outside the repository, and both signal probes were rerun successfully. No runner safety control was altered.

Final test-only housekeeping made TCP proxy closure unconditional even if the disposal assertion fails. The 22-case focused suite was rerun and passed after that cleanup refinement. A subsequent lint warning about the child fixture's inferred pause-promise type was resolved with an explicit Promise annotation and an assertion that the real draining pause was observed, preserving the regression. Lint passed again without warnings. Production source is unchanged since the successful complete regression run. The applicable four-case scheduler/TCP suite was rerun for the last child-fixture refinement: **4/4 passed**. An early external inventory assertion counted only the two new files rather than also including the previously clean Redis fixture; the live inventory was verified as 46, with no unrelated paths.

## Final integrated Astra audit corrections — 2026-10-31

The final independent audit returned **FAIL**, despite the earlier focused PASS reviews. It reproduced a MEDIUM defect in `MaintenanceRetryRepository.closeCompleted()`: after an independently completed M12 journal, both `reserved` and `blocked_execution` rows could become `closed`, erasing attempt, incarnation, permit and journal-token evidence. Journal completion establishes deletion completion; it cannot establish that a different automatic attempt's filesystem operations have drained. The production coordinator's separate passive completion sweep already preserved this evidence; the older generic library primitive did not. The earlier broad preservation statement above must be read with this correction.

The reviewed baseline was reconstructed byte-for-byte before editing: **46 files (9 modified, 37 additions)**, **446,100 bytes**, SHA-256 `40139473568a78c181616fdb9f37593a7dc7eb5d05e1e146b696728f1772f417`. HEAD remains `8ef39c835fa0c18a31cfe63a6ae63b645427f201`; the index remains empty. The prior review patches and phase reports are preserved.

### Focused implementation

- `closeCompleted()` permits generic closure only for `due` and `cooling`, with an atomic SQL state predicate as well as validation under journal-first/retry-second locks. Completed journal and expected generation remain mandatory; transaction-local synchronous commit and timeout settings are unchanged. Only state, due time and revision change. Counters, error history and clearance references are preserved.
- `reserved`, `blocked_execution` and `blocked_admission` return `ineligible` without mutation. Already closed rows remain idempotent; stale generations remain refused. No attempt evidence, clearance, counter or generation is changed to force closure. Evidence-backed execution resolution remains separately gated.
- Seven new real-PostgreSQL cases cover both unresolved states after M12-compatible manual journal completion, both passive states, blocked admission, idempotence/stale generations, and both transaction race orderings. Independent pools actually wait on the journal lock, observed through `pg_stat_activity`, before revalidating state after the winner commits. The blocked-execution test retains a non-NULL predecessor journal token. Entire retry snapshots and clearance rows are compared for evidence preservation.
- The LOW sticky-error gap now has a permanent real-disposable-Redis regression. A real initialized BullMQ consumer receives a controlled cleanup error while production listeners are installed; both actual transport-end events are positively observed. Shutdown remains incomplete across repeated calls. A temporary negative control removes **only** the sticky-error guard and retains termination waiting; the same test detects false clean shutdown. Existing combined-error/termination controls remain intact. No test-owned error listeners mask production handling.

### Regression sensitivity and evidence

Focused PostgreSQL: **7 passed**, 16 unrelated cases filtered. Against an external copy of the original vulnerable repository, the two unresolved-evidence tests **failed as expected** (`applied` instead of `ineligible`), with 21 unrelated cases filtered. The owned disposable runner and its isolation checks were unchanged. Focused sticky-error cases: **2 passed**, 18 unrelated cases filtered; the unsafe child intentionally exits with an assertion failure that the parent verifies. These deliberate negative controls are evidence of detection, not unexplained suite failures. No filesystem executor is invoked by the PostgreSQL fixtures.

Full corrective verification (executed locally after the fix):

| Command/check                                                           | Actual result                                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run build`                                                         | Passed, including native helper compilation; repeated by the established scripts.                   |
| `npm run typecheck`                                                     | Passed.                                                                                             |
| `npm run lint`                                                          | Passed.                                                                                             |
| `npm run test`                                                          | **268 passed**, 28 files.                                                                           |
| `npm run test:e2e`                                                      | **60 passed**, 8 files.                                                                             |
| `npm run test:integration`                                              | **355 passed**, 18 files; **6 native-storage cases skipped** in one file.                           |
| `npm run test:migrations`                                               | **106 passed**, one file; these overlap the PostgreSQL integration cases.                           |
| `npm run test:redis`                                                    | **48 passed**, four files, including lifecycle and repeated SIGTERM/SIGINT regressions.             |
| `npm run test:maintenance`                                              | **54 passed**, two files, including permit and production-process signal regressions.               |
| `npm run test:runtime-smoke`                                            | Passed: malformed configuration and unavailable authentication database produce safe nonzero exits. |
| Focused Prettier, relative Markdown links, tracked/untracked whitespace | Passed for the corrective files and report; 3 relative links resolved.                              |
| Controlled-driver preservation                                          | Existing child probe statements match the reviewed version after parsing/formatting.                |
| Negative controls                                                       | Vulnerable PostgreSQL method: 2 expected failures; sticky-only mutation: false success detected.    |
| Hosted CI, native certification, power loss                             | **NOT RUN**.                                                                                        |

No unplanned test failure occurred during the corrective run. The deliberate negative-control failures are documented above. All owned PostgreSQL/Redis containers were removed after the successful suites and negative controls; final label-filtered listings were empty. Normal runner isolation and cleanup safeguards were unchanged. The audit's independently executed results remain historical evidence and are not substituted for this corrective run.

Exactly five files differ from the final-Astra 46-file baseline: this report, `maintenance-retry.repository.ts`, `maintenance-retry.integration-spec.ts`, `worker-lifecycle.redis-spec.ts`, and `helpers/worker-initialization-child.mjs`. The cumulative inventory remains 46 (9 tracked modifications and 37 untracked additions). The new external correction-only/cumulative patches and manifest use the `saefr-m13b3-final-audit-` prefix; prior artifacts remain unchanged. Independent re-review, checkpoint approval and any B.4 authorization remain outstanding.

### Unchanged boundaries

The only production source correction is generic passive closure eligibility. No migration, schema constraint, dependency, worker configuration, automatic reservation, recovery consumer, takeover-clearance issuance, M12 executor or storage-provider behavior changed. Maintenance remains disabled by default and passive-only when enabled. B.4, real-data migration, recovery permit arming, deployment and public exposure remain separately authorized operations. Unknown COMMIT and remote outcomes, external-supervisor requirements, controlled restore/process fencing, dependency advisories and native durability limitations remain as described above. The original checkout, development PostgreSQL, media, storage markers and persistent volumes remain untouched.
