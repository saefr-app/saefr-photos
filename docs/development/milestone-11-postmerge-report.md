# Milestone 11 — post-merge verification and documentation closeout

- **Status:** M11 implementation and local post-merge verification completed on `integration`. This report records the documentation closeout and historical verification evidence. It does not authorize public deployment, real-data migration, or merging into `main`.
- **Merge:** [PR #4](https://github.com/saefr-app/saefr-photos/pull/4) merged on 2026-10-23 at 19:58:39 UTC as `2141bb955b251ca44132d13af7ebfe3b18c7dfc2`. Remote `integration` pointed to that commit at verification.
- **Reviewed source:** `feat/m11-asset-ownership` at `e4c1aa3d2400e61a1303b28ceb983456bedf041c` is the merge commit's second parent; the merged tree matches that reviewed source tree exactly. The first parent is prior `integration` at `4b2f1d632d30ad044ec968b05b33778e821b76cc`. Remote `main` remained `dfd22e64317c4ea6fc7ddd91e797c4793ae498fa`.
- **Historical evidence:** The [M11F report](milestone-11f-report.md) records pre-merge verification and independent security review. Its then-current PR status is preserved as history.

## Actual post-merge verification

Checks ran on 2026-10-24 from `server-nest/` in a clean, temporary detached worktree at the exact merge commit. Node.js `v24.22.0`, npm `11.19.1` and Docker server `29.7.2` were available. `npm ci` installed the committed dependency set. E2E ran with synthetic database settings and an unavailable localhost database port, never the development database.

| Command or check                                                                     | Result                                                                                           |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `npm ci`                                                                             | PASS.                                                                                            |
| `npm run build`                                                                      | PASS.                                                                                            |
| `npm run typecheck`                                                                  | PASS.                                                                                            |
| `npm run lint`                                                                       | PASS.                                                                                            |
| `npm run test`                                                                       | PASS: 13 files, 98 unit tests.                                                                   |
| `npm run test:e2e`                                                                   | PASS: 7 files, 52 HTTP E2E tests with synthetic configuration.                                   |
| `npm run test:integration`                                                           | PASS: 7 files, 173 disposable PostgreSQL integration tests.                                      |
| `npm run test:migrations`                                                            | PASS: 1 file, 65 migration tests, also included in the 173-test integration suite.               |
| `npm run test:runtime-smoke`                                                         | PASS: invalid configuration and unavailable authentication database produced safe nonzero exits. |
| Prettier on all 43 M11 changed files; `git diff --check` against prior `integration` | PASS.                                                                                            |

The E2E command used these synthetic process settings; port 1 had no PostgreSQL listener:

```bash
POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=1 POSTGRES_DB=saefr_isolated_e2e \
  POSTGRES_USER=saefr_isolated_e2e POSTGRES_PASSWORD=synthetic-e2e-only \
  STORAGE_ROOT=/tmp/saefr-m11-postmerge-e2e-unused NODE_ENV=test \
  APP_ORIGIN=http://127.0.0.1:3000 npm run test:e2e
```

No required check failed during this post-merge run. The verified integration runner used two separate randomized `postgres:18` containers with generated credentials, tmpfs-only database storage and localhost-only ports. It reported removal of `saefr-m7-test-79c891afdd22` and `saefr-m7-test-2f7477ec03e5`; a subsequent filtered Docker listing found no disposable test container. Test media lived in temporary directories. No development PostgreSQL data, persistent Docker volume, original photograph or thumbnail was accessed or modified, and no real-data migration command was run.

The merged application mounts owner-scoped asset routes behind the early session and Origin/CSRF gate. Repository reads require an owner predicate; administrators have no cross-owner media privilege, and legacy NULL-owned rows remain inaccessible. Uploads derive ownership from the actor, revalidate authorization at final insertion and retain files when the database commit outcome is uncertain. Startup requires the exact M11 schema and migration history before listening and never migrates automatically. The local checks support these boundaries; they are not production deployment validation.

## Findings and remaining gates

- **No GitHub CI success:** PR #4 showed no status checks. The repository has no project-owned `.github/workflows` CI file; GitHub's dynamic Copilot agent workflow is not a project test pipeline.
- **Dependency-audit follow-up:** At verification, `npm audit` reported two low-severity production findings involving Fastify and three moderate-severity development-tool findings involving Vitest, with no high or critical finding. `npm audit --omit=dev` exited nonzero for the two low-severity findings. No dependency change or advisory remediation was made during this documentation closeout.
- **Real-data upgrade not approved:** The development database remains unmigrated and old M10 binaries reject the M11 schema. A matching PostgreSQL and media backup, tested restore, isolated migration rehearsal, maintenance window, compatibility review and separately approved recovery procedure are required before an upgrade. Restoring historical NULL-owned rows into an already-M11 catalog needs special rehearsal because the unvalidated ownership check still enforces subsequent writes.
- **Legacy media and recovery:** Existing NULL-owned assets remain quarantined. Optional M11E provenance-based mapping is deferred; no ownership was inferred or assigned. Filesystem/PostgreSQL writes are not fully atomic, and crash reconciliation and comprehensive filesystem failure injection remain open. An already-started stream may finish after revocation; asset listing remains unpaginated.
- **Deployment and release:** Production TLS/reverse-proxy/cookie behavior, backup/restore operation and a publicly exposed deployment were not validated. Merging into `integration` does not approve deployment, a real-data migration or a merge into `main`, which remains reserved for a separately validated self-hostable alpha.

M11 implementation and local post-merge verification are complete on `integration`. This report records source and test evidence; it does not authorize any remaining operational gate. The [approved specification](milestone-11-spec.md), [accepted ADR 0005](../decisions/0005-asset-ownership.md) and phase reports for [11B](milestone-11b-report.md), [11C](milestone-11c-report.md), [11D](milestone-11d-report.md) and [11F](milestone-11f-report.md) retain their original historical context.
