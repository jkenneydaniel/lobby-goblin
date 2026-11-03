# Development lead checkpoint and recovery

This is a controller design and checkpoint template, not an implemented daemon.
It is separate from Lobby Goblin's in-product operation records and host agents.
It must never reuse installed panel/game state or the product's jobs database.

[checkpoint.schema.json](checkpoint.schema.json) defines the version 1 record;
[checkpoint.example.json](checkpoint.example.json) is an inactive starting record.
Store operational state at `.autonomy/checkpoint.json` in the lead worktree or in
an explicitly selected durable controller store. `.autonomy/` is ignored and not
a backup. The controller must preserve it across workspace replacement before
unattended work is viable. Keep public-safe continuity in lead-owned issue/PR
records after publication is authorized. Do not commit credentials or private
run transcripts as continuity material.

## Ownership and write protocol

One logical project lead owns planning and one issue may have a writer. Only the
controller writes lease/authority/budget fields; workers return observations for
the lead to reconcile. Policy text and checkpoint flags are instructions and
records, not security enforcement. Runtime permissions remain platform-enforced;
a future scheduler must enforce its run limits and single-writer ownership. No
custom broad action broker is required. Recorded user approval must match the
repository and exact allowed actions. An agent cannot approve its own proposal.

For a local single-controller implementation, use an exclusive lock and a
monotonically increasing generation/fencing token. Write a checked record to a
same-directory temporary file, flush it, rename atomically, and flush the parent
directory where supported. Reject stale revision/generation writers. Append a
bounded, redacted action journal before remote submissions and preserve previous
valid state. Local atomic rename alone does not provide distributed locking or
guarantee power-loss durability. A shared store needs compare-and-swap and lease
enforcement rather than a copied lock file.

Checkpoint before delegation, before/after each authorized external mutation,
after substantive validation and before returning control. Record repository/base
and candidate SHAs, issue/PR/Project IDs, priority rationale, owned worktrees,
specialist outcomes, exact verification, blockers, budget used and next action.
GitHub remote state is authoritative for remote objects; a local intent is not
proof of remote success. No transcript or session ID is the sole recovery plan.

## External action journal

Each action record contains a stable `key`, kind, exact target, expected remote
version where available, content fingerprint, intent time, status and remote
identifier/result. Status is `prepared`, `confirmed`, `failed` or `uncertain`.
Journal keys and fingerprints must be reused on retry, not regenerated.

For issue creation, include an unobtrusive stable discovery marker in the issue
body and check open/closed issues for it. For PR creation, reconcile exact head
branch/base and linked issue. For a push, compare the remote branch SHA. For
comments, inspect the target thread and stable marker/content fingerprint. For
Project additions/field changes, read actual item IDs/values before retrying.
Never treat a timeout as a failure that permits blind replay.

## Restart algorithm

1. Confirm pause/authority/budget, acquire an exclusive lease and a new fencing
   generation, and prevent older workers from writing. An expired timer does not
   prove a previous process has stopped. Inspect/cancel it or withhold effects.
2. Load and validate the checkpoint and previous valid copy. If missing/corrupt,
   reconstruct from approved scope, lead-owned refs/issues/PRs and the journal;
   stop before effects when identity or ownership is ambiguous.
3. Inspect local dirty files, branches/worktrees, remote refs, issues/PRs, review
   threads and checks. Reconcile every uncertain submission before selecting work.
4. Resume the concrete next action within remaining limits. Reconcile feedback
   and CI on the existing PR first. Never run an installation or replay a product
   operation as a development recovery step.
5. Record results and `next_action`, release/fence specialists and the lease, and
   return. `wake_request` records a desired future wake-up; it does not schedule
   one. Report absence of a controller instead of promising automatic resumption.

At each real controller rollout, prove interruption before/after issue creation,
push, PR creation and comment publication causes no duplicate effects; prove
simultaneous wake-ups leave one writer; prove lost/stale leases fence old workers;
prove budget/pause/auth failures checkpoint and stop. Also test CI failures,
review-request changes, corrupted state and a replaced environment. These fault
tests and the controller implementation remain outstanding.
