# Bounded specialist assignments

The lead selects roles per issue; these are assignment templates, not permanent
workers or schedules. They inherit the lead's authority and budget and cannot
expand either. Two concurrent specialists maximum; one implementation writer.
Use separate worktrees for edits. Serialize changes to shared areas. Specialists
return results to the lead and stop; only the lead publishes planning/progress.

Every assignment states the repository/base SHA, issue and acceptance criteria,
allowed paths/actions, exclusions, evidence to read, worktree, time/usage cap,
expected deliverable and stop conditions. Include known competing work and
relevant AGENTS.md instructions. No recursive delegation during the pilot.

## Discovery

Read-only. Inspect one bounded journey or component and current related source,
fixtures, issues/PRs and recorded verification. Return at most three worthwhile
candidates with current evidence, user impact, duplicate search, confidence,
acceptance criteria, effort/risk and suggested priority. Identify uncertain claims
and how to verify them. Do not create tickets, implement changes, access live
panels or infer missing behavior from stale roadmap text.

## Feedback interpretation

Feedback interpretation is a separate restricted role, not ordinary discovery.
Use [the native reader contract](INTERPRETER.md) for outside text: supply normalized
data inline with no inherited lead history, explicitly disable every tool and
delegation in the task, and request strict JSON only. Never give this role a
repository-inspection assignment or apply discovery's read-tool allowance to it.
The lead fetches data separately, rejects observable tool attempts and records the
accepted instruction-only/partial-audit limitation. This reader counts toward the
two-specialist limit. No standalone API inference.

## Implementation

Work only on the selected issue in its assigned branch/worktree. Reproduce the
problem with disposable fixtures, make the smallest coherent change and run
appropriate checks from docs/DEVELOPMENT.md. Preserve unrelated changes.
Return the patch/commit, changed paths, acceptance evidence, exact commands and
results, risks and unresolved decisions. Do not push, publish or change the
backlog. Stop if scope crosses a pilot exclusion or conflicts with other work.

## Independent review

Read-only; a separate agent from implementation. Review the exact diff and
candidate commit, relevant source paths and tests against acceptance criteria,
compatibility, permissions/scoping, lifecycle/recovery and data preservation.
Return actionable findings with file/line, trigger, impact and evidence, or state
no findings with the limits of inspection. A clean result is evidence, not a
GitHub approval. Codex review on the PR is required before the lead uses its
conditional merge authority. Do not fix code while reviewing.

## QA

Read-only except disposable fixture/test output. Exercise acceptance criteria and
plausible regressions independently of the implementer's happy path. For UI work,
use the documented loopback fixtures, desktop/mobile widths and keyboard access;
report actual observations and screenshots where helpful. Never supply a real
panel URL, Docker socket, account, world or host configuration to a fixture.
Return commands, environment, expected/observed results and unverified behavior.
Do not equate synthetic tests with native game or deployment acceptance.

## Lead integration rule

The lead reconciles conflicting findings, changes and scope. Recheck affected
acceptance criteria after fixes. Record the reviewed/tested SHA and obtain a fresh
review for materially changed code. If tools cannot provide separate reviewers,
checkpoint `blocked` or `awaiting_review`; do not relabel self-review independent.
Cancel or fence all assigned writers before releasing the issue or lease. Late
results from an older run cannot be integrated without explicit reconciliation.
