# ADR 0003 — Proposed integration and first-alpha branch strategy

- **Status:** Proposed; apply only after explicit maintainer approval

## Proposal
Finish integration tests, migrations and hardening on the existing `refactor/nestjs-migration` branch. Then create **`integration`** from its verified head. Use `integration` as the working shared baseline for independently reviewed feature branches (`feat/auth-foundation`, etc.). Keep `main` as the first deployable-alpha target until the secure self-hosted stack passes validation.

## Why
Avoid long-lived work under a misleading migration branch name while keeping the release target stable. Make it easier for multiple developers to review and integrate independent work through PRs.

## Trade-offs
A persistent integration branch adds operational and merge overhead. Many teams use short-lived branches and continuously merge to `main`; reconsider after the first alpha is established. Never confuse ``branch was merged`` with ``system was released``; publish alpha tags and release notes deliberately.

## Approval gate
Do not create `integration`, merge branches, delete old branches, or tag a release based solely on this proposed ADR. Ask the maintainer first.
