# Milestone 10 — Phase 10B.5 administrator account management

- **Status:** Implemented on `feat/m10-auth-foundation`; awaiting maintainer review. Not staged, committed or pushed.
- **Base:** reviewed 10B.4 checkpoint `d5d91d797b05040829c6e122afd3ab9a2a902bcc`.
- **Date:** 2026-10-22.

## Implementation and exact files

- New: `server-nest/src/users/users.controller.ts`, `users.service.ts`, `users.module.ts`, `server-nest/test/users-http.integration-spec.ts`, and this report.
- Modified: `server-nest/src/app.module.ts`, `src/auth/auth.module.ts`, `src/errors/safe-http-exception.filter.ts`, `src/users/username.ts`, `src/users/operator-accounts.spec.ts`, `docs/architecture.md`, `docs/roadmap.md`, `docs/development/milestone-10-spec.md`, and `docs/development/milestone-10-implementation-context.md`.

`POST /api/v1/users` accepts exactly `{username,initialPassword,currentPassword}`, creates only an active ordinary user with mandatory first password change, and returns the seven approved public fields with 201. Canonical username conflicts return a fixed 409. `GET /api/v1/users` defaults to `limit=50&offset=0`, validates limit 1–100 and nonnegative safe-integer offset, orders by username then UUID, and returns only public account fields in `{items,limit,offset}`. `POST /api/v1/users/:id/disable` accepts exactly `{currentPassword}`, requires a canonical UUID, returns 204, marks the target disabled and deletes all target sessions. It never deletes an account.

All three routes are protected by the existing default-deny session guard. They require an active administrator with an unrestricted session; both mutations require exact Origin and the session CSRF token. Creation and disable additionally use the existing bounded reauthentication-attempt and Argon2 work controls. The current administrator password is verified against the current hash while its account row is locked. Responses contain no password, hash, cookie, session token, CSRF value or internal media path. The safe exception filter allows only fixed new 409 messages; unexpected failures log a safe error category and return a sanitized 503. Wrong current password returns 401; a validly reauthenticated administrator receives 404 for an unknown target, 409 for self-disable or the last-active-admin condition.

## Transactions, races and data safety

Account creation hashes the supplied initial password, then rechecks the administrator's active, unrestricted state and current password under `app_user FOR UPDATE` before insertion. A concurrent password change or account disable therefore either completes before that recheck and invalidates it, or waits until this creation commits. The database unique constraint handles concurrent canonical username creation.

Disable takes a dedicated transaction-scoped PostgreSQL advisory lock **before** user-row locks, then reauthenticates the administrator under its row lock, rejects self-disable, locks the target row, checks the active-admin count, advances the target's existing `updated_at` revision strictly, marks it disabled and deletes its sessions in the same transaction. The advisory lock serializes cross-disables by separate administrators, so at least one active administrator remains. The test holds this lock until both cross-disable HTTP calls have entered the service, then releases them and verifies exactly one administrator remains active. Login takes the target row lock before session insertion and rechecks current status and revision; a login committed first is revoked by disable, while a login verified before disable commits is rejected after it resumes. The login/disable test pauses verified login before the row lock and commits disable before resuming it. Session resolution checks current status on every request. Requests authorized before revocation may finish; later requests fail.

The production `AppModule` still excludes `AssetsModule`. The early Fastify lockdown still rejects anonymous asset requests with 401 and authenticated user or administrator asset requests with 503 before multipart parsing. No ownerless photograph access was introduced. No schema or historical migration file changed. No real development database, Docker volume or stored media was touched; integration tests used the verified random `postgres:18` tmpfs container and random databases.

## Final review corrections

The shared username helper now trims surrounding whitespace, rejects non-printable or non-ASCII characters **before** lowercasing, then applies the unchanged canonical pattern and 3–64 character limit. This closes Unicode case-folding inputs such as `Kevin` without changing valid ASCII names. Unit assertions cover uppercase normalization, whitespace, boundaries, Kelvin sign, dotted-I, Cyrillic/fullwidth lookalikes and an invisible Unicode separator. Real HTTP/PostgreSQL tests confirm case-insensitive duplicate rejection, Unicode rejection and login with uppercase/whitespace spelling of a newly created username.

Two real localhost HTTP/PostgreSQL cases restore the actual `AttemptLimiter` after test login. Each makes ten failed current-password attempts, then proves that a correct-password create or disable request is blocked with a fixed JSON 429 and `Retry-After: 900`, without creating or disabling the target. The cases use fresh administrator IDs, remain below the separate IP-wide budget and run at the end of the suite; the other admin tests retain their isolated limiter mock. The 429 body contains no submitted password or password hash. Production limits were unchanged.

## Actual verification

Run from `server-nest/` on Node.js `v24.22.0`:

| Command/check                                                                                          | Result                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| `npm run build`                                                                                        | PASS                                                                                                   |
| `npm run typecheck`                                                                                    | PASS                                                                                                   |
| `npm run lint`                                                                                         | PASS                                                                                                   |
| `npx prettier --check` on changed TypeScript and documentation                                         | PASS                                                                                                   |
| `npm run test`                                                                                         | PASS: 13 files, 90 tests                                                                               |
| `npm run test:e2e`                                                                                     | PASS: 7 files, 48 tests, including existing asset lockdown                                             |
| `npm run test:integration`                                                                             | PASS: 5 files, 91 tests, including 13 new real-socket admin cases; final disposable container removed. |
| `npm run test:migrations`                                                                              | PASS: 1 file, 44 tests; disposable container removed                                                   |
| `npm run test:runtime-smoke`                                                                           | PASS: invalid configuration and unavailable auth DB safely fail                                        |
| `git diff --check` and `git diff --no-index --check` for all five untracked files                      | PASS: no whitespace errors; 14 Phase 10B.5 files remain unstaged                                       |
| `docker ps -a --filter label=dev.saefr.purpose=milestone-07-integration --format '{{.ID}} {{.Names}}'` | PASS: no disposable container remains                                                                  |

The initial typecheck found an incorrect TypeScript transaction type in the new service; it was replaced with Kysely's `Transaction<Database>`. An initial lint pass warned about an array sort without a comparator; the test now supplies one. Focused Prettier checks initially found formatting in the new test and then the updated Markdown tables; both were formatted and rechecked. The first full integration run failed one **test expectation**: the generated `admin…` username sorts before `alphauser`, while the assertion expected the reverse. Production ordering was already stable and correct. The assertion was corrected. Four subsequent full runs passed 89/89: after the assertion correction, after adding logging-redaction coverage, after adding missing-CSRF and disable-denial assertions, and after making the cross-disable ordering deterministic. Every run's disposable container was removed. No failed run is claimed as a pass.

The new real HTTP/PostgreSQL cases cover account creation and safe projection; duplicate/invalid usernames and weak/malformed passwords; wrong administrator password; ordinary and restricted-session denial; pagination; Origin/CSRF failures; disable and immediate session/login rejection; unknown, self and malformed targets; concurrent cross-disables preserving one active administrator; a deterministic login-verification/disable race; stale reauthentication after password change; and sanitized unexpected query failures. Existing session, migration and ownerless-asset tests remain in the full suites.

After the final review corrections, build, typecheck, lint, focused Prettier, 90 unit tests, 48 HTTP E2E tests, 91 PostgreSQL integration tests, 44 migration tests and runtime smoke passed. The first lint run after the username change emitted a control-character-regex warning; the check was rewritten as a printable-ASCII precondition and lint then passed without warnings. Both integration commands removed their disposable containers. The pre-correction 89-test runs remain historical evidence above; the 91-test result is the current full integration result.

## Limitations and Phase 10B.6 handoff

The last-active-admin check is a defensive transaction invariant; for valid active administrators, self-disable prevention already makes the one-admin case unreachable through HTTP. A host operator with direct database access remains trusted. An in-flight request authorized before disable commits can complete. Temporary-password delivery is out of band and unverified. The in-memory throttle resets on restart. Deployment TLS/proxy behavior, a real upgrade/backup rehearsal and filesystem failure injection remain open. M11 must add an approved owner mapping and repository authorization before media can be served.

Phase 10B.6 requires separate authorization. Review the full 10B.5 diff and this report first; do not run a development-database migration, enable asset routes, merge or publish as part of this phase.
