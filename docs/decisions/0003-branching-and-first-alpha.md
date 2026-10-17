# ADR 0003 — Integration and first-alpha branch strategy

- **Status:** Accepted; `integration` created from the completed Milestone 9 foundation at `94e54c9`

## Decision
Use `integration` as the shared baseline for independently reviewed feature branches. Create each feature branch from an up-to-date `integration` and merge it back through a reviewed pull request after relevant checks pass. Keep `main` reserved for the first validated, secure, persistent and documented self-hostable alpha.

## Why
Avoid long-lived work under a misleading migration branch name while keeping the release target stable. Make it easier for multiple developers to review and integrate independent work through PRs.

## Trade-offs
A persistent integration branch adds operational and merge overhead. Many teams use short-lived branches and continuously merge to `main`; reconsider after the first alpha is established. Never confuse ``branch was merged`` with ``system was released``; publish alpha tags and release notes deliberately.

## Release gate
Creating `integration` does not approve a merge into `main`, a release tag or deployment. The maintainer must separately approve the first `main` merge after self-hostable alpha validation. Do not merge, delete branches or tag a release based solely on this ADR.
