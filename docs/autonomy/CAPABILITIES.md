# Observed capabilities — 2026-11-03

This is a point-in-time capability inspection, not an authorization record.
Recheck it at activation. After inspection, the authorized foundation is published
for review as recorded in VERIFICATION.md. No live-server operation or credential
creation was performed.

## Repository and competing work

- Source checkout: `/workspace/lobby-goblin`, clean branch `work`, HEAD
  `a3adf8e261b57a624258238fce49d1c13298c1ea`, matching live `main` from GitHub.
  The local `origin/main` ref was stale and was not used to select the base.
- Package version: `0.3.21-alpha`. Recent work merged Factorio compact map
  payloads and map capacity through PR #50. Prior storage, updates and provider
  changes are already integrated; do not restart those projects from old plans.
- GitHub connector search and REST reads both returned no open issues or PRs.
  The first 100 all-state PRs contained no unmerged PRs. There are many retained
  feature branches, not evidence that their owners are currently working.
- GitHub Actions reads found no queued/in-progress runs. Current-main Test and
  build [run 41055147220](https://github.com/jkenneydaniel/lobby-goblin/actions/runs/41055147220)
  and latest release packaging
  [run 41055203587](https://github.com/jkenneydaniel/lobby-goblin/actions/runs/41055203587)
  report success on this SHA. No new hosted run was triggered.
- Original checkout had one worktree and no visible separate implementation
  process. Other cloud conversations or human unpushed work cannot be ruled out.
  Recheck coordination before editing product code; do not delete old branches.
- No preexisting AGENTS.md or repository `.agents/skills` was found. Mounted
  `/workspace/.agents` and `/workspace/.codex` are empty/read-only. This branch
  adds guidance without changing the original checkout.

## GitHub and events

| Capability | Observed support and limits |
| --- | --- |
| Repository, issues, PRs, branches | Connected GitHub tools and authenticated `gh api` reads succeeded for this repository. |
| Write capability | Connector metadata reports admin/maintain/push/triage access. Tools advertise issue create/update/labels/assignees, branch/content writes, draft PR create/update, PR comments/review replies and thread resolution. No write was exercised or authorized in this pass; actual operation-specific permissions may differ. |
| CI feedback | Tools advertise combined status, workflow runs/jobs/logs/artifacts and failed-job reruns; Actions REST reads succeeded. The connector's commit-workflow helper filters to PR runs/first page, so use pagination/REST when needed. Check all required checks for the exact head SHA. |
| Projects v2 | No Projects reader/writer exists in the exposed GitHub connector inventory. `gh project list --owner jkenneydaniel --format json --limit 100` returned `GraphQL: Resource not accessible by integration` on Project nodes. Board identity/content and write authority remain unverified. |
| Protection inspection | Branch-protection REST read returned HTTP 403; the rulesets listing returned an empty list. This does not establish absence of protections. Use normal protected merge paths, current checks/Codex review and no bypass. |
| Events | Native connected-source listing and GitHub event schema discovery succeeded. Supported: PR opened/ready/closed; optional synchronize, submitted human reviews and new human PR conversation/inline comments. Explicitly unsupported: ordinary issue events/comments and edited/deleted reviews/comments. No CI-completed event is exposed; Codex bot reviews cannot be assumed to wake it. No subscription was created. |
| Scheduling | Native automation tools exist, but no recurring job was created and their ability to launch a source-editing run bound to this environment was not demonstrated. Page/Sites/email-specific controllers are not a verified repository controller. |

Projects is an actual integration-access blocker, not a reason to ask Daniel for
tickets. Resolve app/project permissions through a supported account connection,
and continue the authorized Issues work independently. Do not guess a board or
mint a credential. Tool support, effective access and user authority are separate checks.

## Execution and validation surface

- Current cloud session: shell/files, native bounded subagents and GitHub tools
  are available. Saved environment startup completed. No controller persistence,
  automatic resumption or cross-run lease service is established.
- Node `v24.19.0`, npm, Python 3, `gh`, Docker CLI/daemon and existing runtime,
  browser and quality dependencies are present. Docker presence is not permission
  to inspect containers, mount storage or run native acceptance. No daemon/server
  command was issued in this inspection.
- `codex-cli 0.163.0` is installed. Help advertises `exec`, `resume`, `--json`,
  `--output-schema`, read-only sandbox and ephemeral runs. `codex login status`
  reports ChatGPT authentication. A bounded no-tools/no-write probe with
  `codex exec --ephemeral --sandbox read-only --color never --json ...` exited 1:
  `failed to initialize in-process app-server client: Read-only file system`.
  No model result/session resume was established. No credential copying or
  protection bypass was attempted. CLI presence/auth status cannot prove a
  working controller runtime.
- `npm test --prefix panel` uses disposable/mock transports; browser regressions
  use loopback-only synthetic fixtures; static quality is a separate locked
  package. CI also runs fresh-engine Docker acceptance, cross-platform host
  launchers, builds and source packaging. Local mock/browser results must not be
  described as live-game, other-OS or installation acceptance.
- Release publication, image publication and deployment have separate workflows
  and consequences. No workflow has been modified to run the development lead.

Local foundation validation is recorded in [VERIFICATION.md](VERIFICATION.md).
