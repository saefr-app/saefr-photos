# Team Workflow — ChatGPT, Codex, Git and Reviews

## Roles and handoffs

- **ChatGPT/planning:** discuss scope, architecture trade-offs, security and milestone acceptance criteria.
- **Codex/local implementation:** read repo guidance and the current milestone specification; inspect actual source; plan, code, test, prepare report. Work only inside approved scope.
- **Human maintainer:** inspect diff/test evidence, question decisions, approve/reject code and destructive actions, decide when to commit/push/merge.
- **Contributors:** mobile/client and Python ML workstreams can proceed on their own feature branches, using reviewed contracts and pull requests into `integration` when ready.

## Source-of-truth hierarchy

1. Implemented code and verified live behaviors for **current capabilities**.
2. Accepted architecture decisions in `docs/decisions/` for **intended constraints**.
3. Approved milestone specification for **scope now**.
4. `docs/roadmap.md` for **future direction**.
5. Chat conversations for brainstorming, **not** as automatic agent memory.
   Report conflicts and ask; don't silently rewrite requirements.

## One milestone at a time

1. Plan in ChatGPT; create a bounded, reviewable milestone spec in `docs/development/`.
2. Start Codex in the **correct repository and current branch**; instruct it to read `AGENTS.md` and relevant documents.
3. Agent checks `git status`; stops if conflicting uncommitted changes would be overwritten.
4. Agent writes tests and implements. No secret, media or development DB mutation without specific approval.
5. Agent runs relevant checks and produces report following `docs/development/milestone-report-template.md`. Any not-run test must be marked **NOT RUN**.
6. Maintainer reviews changes, asks questions, verifies important behavior locally. Revise if necessary.
7. With explicit approval: commit (focused conventional commit message), push. Do not automatically start the next milestone.

## Local verification commands (from `server-nest/`)

```bash
npm ci
npm run build
npm run test
npm run test:e2e
npm run lint
```

The established `test:integration` and `test:migrations` scripts use disposable PostgreSQL containers; **never repoint normal `.env` to a disposable database or vice versa**. For manual API exploration, start Nest and use local Swagger `/docs`; those calls may **persist real data**.

## Adopted branch workflow

- `integration` was created from the completed Milestone 9 foundation at `94e54c9` and is the shared baseline. Keep `main` for the first validated self-hostable alpha.
- Create short-lived feature branches from an up-to-date `integration`; submit reviewed pull requests back to `integration` after relevant checks pass. Planned work may use names such as `feat/auth-foundation` or `feat/docker-deployment` when that work is approved.
- For a phased milestone, keep one feature branch and one draft milestone pull request. Commit and push reviewed phase checkpoints on that branch; mark the pull request ready and merge only after the full milestone gates pass and the maintainer approves. A phase checkpoint alone does not authorize later phases or a merge.
- Developers should not chain feature branches from one another. No forced pushes over teammates' work.
- Merge to `main` only after the secure, persistent, documented self-hostable alpha passes validation and the maintainer approves the release. After first alpha, reassess whether a long-lived integration branch remains useful.

## Documentation updates

Keep `architecture.md` factual and `roadmap.md` forward-looking. Record meaningful accepted architectural decisions as short ADRs. For each milestone, save actual results and limitations in a report. Avoid creating new documentation for trivial formatting changes.

## Security and permissions

Prefer permission prompts for commands affecting Docker, DB schema, Git remotes, credentials or persistent files. Even with local Codex access, keep the existing dev DB volume and `storage/` untouched during integration-test setup. Nothing in repository instructions can guarantee safety if a tool is granted unchecked destructive privileges; review the actions.
