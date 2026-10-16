# Codex local setup and context onboarding (Fedora)

## What Codex does and does not remember
Codex can inspect a connected local repo and loads applicable `AGENTS.md` instructions. It does **not** automatically receive every ChatGPT planning conversation or magically know local databases in a cloud task. These committed documents are shared project context; a new task prompt still specifies the immediate milestone.

## Tools needed now
- ChatGPT desktop Codex **local workspace** on Fedora, if your installed build exposes it; otherwise Codex CLI/IDE in the same local repository. Choose whichever can truly access local files and Docker.
- Git and GitHub remote access (`git status`, reviewed PRs). GitHub's ChatGPT plugin is already connected for the planning/review chat; local Codex can use Git CLI without another GitHub plugin.
- Node.js **24** via nvm or equivalent; npm, `npm ci`, NestJS dependencies from lockfile.
- Docker Engine/Podman with compatible Docker Compose access **for test-only PostgreSQL**; production/dev `compose.yml` currently controls the existing PostgreSQL 18 volume. On Fedora, check SELinux/permissions rather than disabling security policies globally.
- A code editor and terminal are useful but not mandatory when desktop Codex provides diffs/terminal.

## First-time preflight
From a terminal on your Fedora host:
```bash
cd ~/Saefr/saefr-photos
git branch --show-current
git status --short
git log -1 --oneline
node --version
npm --version
docker --version
docker compose version
cd server-nest
npm ci
npm run build
npm run test
npm run test:e2e
npm run lint
```
A working Docker CLI does not guarantee Codex's execution sandbox has permission to use the socket; verify separately in the Codex task. If these checks have blockers, note them before accepting implementation claims.

## Start Codex
1. Open desktop Codex and choose **local workspace** pointing at `~/Saefr/saefr-photos` (or CLI/IDE if your desktop does not support it).
2. Select `refactor/nestjs-migration`. Do not change to `integration` before M9 review.
3. Inspect permission/approval prompts carefully. Allow reading and ordinary build/test writes; ask before commands affecting DB, Docker persistent resources, Git history, remote PRs or deployment.
4. Start one milestone task at a time, referring to the spec file, not past chat context.
5. Keep Codex on the same workspace/task thread for questions about that implementation; use fresh tasks for independent milestones with documented handoffs.

## Ready-to-send first Codex prompt
```text
We are working on Saefr Photos, in my local repository, on branch refactor/nestjs-migration.
Check your actual workspace path, git status, Node 24 and Docker access first.
Read AGENTS.md, docs/architecture.md, docs/roadmap.md, docs/team-workflow.md,
and docs/development/milestone-07-spec.md.
Implement ONLY Milestone 7 according to that specification.
Use an isolated disposable PostgreSQL 18 database, never my existing development
DB/volume or image storage. Ask before any destructive or schema-changing command.
Run relevant checks and create docs/development/milestone-07-report.md with
actual results and remaining risks. Show me the diff and a concise summary.
DO NOT commit, push, switch branches or proceed to M8. Wait for my review.
```

## Optional plugins and integrations
- **Already connected**: GitHub plugin in ChatGPT, helpful for browsing commits and reviewing PRs; local Git CLI is sufficient for editing and test cycles.
- **Not needed for M7–M9**: OpenAI Developers plugin or OpenAI Docs MCP (those serve OpenAI API development, not NestJS/PostgreSQL documentation). Figma/Canva, Vercel, ML model plugins, and project trackers are not required now.
- **Useful later**: a project tracker (GitHub Issues/Projects first; Linear optional when team coordination merits it); Hugging Face or model resources for ML prototyping if the ML developer wants them. Install/connect only the minimum needed with restricted permissions.
- You do **not** need a custom Postgres MCP server to run tests; test code and an isolated PostgreSQL container are safer and reproducible.

## Approval and Git checkpoints
- First, add these context files to the current branch, review and explicitly authorize a docs-only commit if desired.
- Start M7 only after context files are in the working tree; Codex can read them before they're committed but the team only shares them once pushed.
- For M7, M8 and M9 use separate implementation/review/commit gates.
- Reassess `integration` naming and creation only when M9 is approved.

## Troubleshooting
- Can't access folder? Confirm *local* task, folder permissions and correct root; cloud checkout has different filesystem.
- Docker permission denied? Do not grant unrestricted root to bypass guardrails. Review sandbox and socket access; ask for minimal permission or run test verification manually in a disposable DB.
- Tests ask for POSTGRES_PASSWORD? Do not paste secrets into chat/report; use local ignored `.env` and test-only config.
- Repo has unstaged edits? Stop before rebase/reset/restore; inspect and preserve developer changes.
- Autoformat changed unrelated files? Inspect `git diff`; stage only milestone files; never discard arbitrary changes.
