# Operation records and workflow recovery

This is the current implementation contract, not completion of the platform
persistence or management-lifecycle work. Existing installations and workers keep
using their established native files and recovery procedures.

## One public record, specialized state machines

`panel/core/operation-record.js` defines the checked public record. It has a
version, source, stable source ID, action, category, current state/phase, actor,
timestamps, optional parent ID, recorded phase observations and recovery controls.
Public IDs are `source:sourceId`; the original source ID remains available for
correlation with older request/audit records.

The categories cover application, lifecycle, configuration, provisioning, backup,
mods, update and host setup. States are queued, running, succeeded, failed and
interrupted. An acknowledgement does not turn an interrupted or failed result
into a success. A completed file transaction is a child outcome; it cannot prove
that its parent's readiness checks or cleanup completed.

A data-only `operationRecord` envelope is saved inside the native record. This
name deliberately preserves existing fields such as an update plan's `operation`
(`upgrade` or `image-change`). Workers that outlive management save the same
envelope with their native state. Phase observations retain actor and timestamp,
with the latest 128 observations per operation. Completed historical jobs remain
readable without an envelope; unavailable historical phases are not fabricated.

| Source | Authoritative storage | Recovery owner |
| --- | --- | --- |
| Application and host jobs | Existing `jobs.json` or host registry jobs | Shared Operations coordinator |
| Standalone panel/game updates | Existing per-update JSON records | Update manager and independent worker |
| Mod library | Current transaction plus per-transaction history beside recovery files | Mod adapter and stopped/hot/restart rules |
| Rust frameworks | Current transaction plus retained recovery transaction records | Rust framework adapter |
| Host setup | Existing host setup job list | Host setup review and pairing workflow |
| Host management updates | Current agent update record plus retained per-update records | Agent updater and recovery worker |

The current transaction copy takes precedence over an archival copy for the same
ID. An interrupted transaction remains uncertain after management restarts. A
rolled-back transaction reports a failed original outcome. Old management update
records survive subsequent updates; histories do not include replacement specs,
container environments, credentials, raw file data or private recovery paths.

A lost Docker create/start response does not prove that an update worker failed
to start. Once submission begins, the manager preserves the worker-owned journal
and returns the accepted operation. Later inspection determines its outcome;
request error handling must not overwrite a worker's running or terminal record.

## Provider contract

`panel/core/operation-feed.js` composes reviewed sources. Applications may expose
`operationSources` from their controller; an updater may expose `operationSource()`.
A source supplies:

- A unique fixed `id`, a display `label` and an asynchronous `read()` returning
  checked public records for that source.
- Optional `recover(input, actor)`, limited to the actions advertised by that
  record, and optional read-only `inspectJob(job)` for correlated parent review.
- Explicit recovery controls: inspection, acknowledgement where the owning
  workflow permits it, or a fixed in-panel link to specialized recovery tools.

Registration rejects duplicate source IDs and invalid hooks. Reads validate
identity, state, category, timestamps, phase history and recovery controls before
publishing any records from that source. A failed or malformed source is reported
as unavailable; partial records cannot imply a successful empty history. Native
payloads are not spread into public history.

The feed returns the latest 500 records plus retained active/recovery records.
Per-source reads are bounded. Source paging, retention repositories and stronger
cross-process transactions remain part of the persistence work.

## Shared API and product component

`GET /operations` returns the versioned feed. `POST /operations/recovery` selects
one registered source and its original record ID. It rejects unadvertised actions;
checking history never automatically retries a mutation. The web API requires an
administrator for history and recovery, plus the normal origin/session/CSRF checks
for a recovery POST. Existing delegated operation and image/mod interfaces retain
their existing permissions. Modules cannot relax shared endpoint roles.

Both game definitions and the synthetic non-game definition select the same
`operations` presentation component. Its markup is in
`public/application/operation-templates.html`; its loading, filtering, expansion,
requests and event lifetime are owned by `public/shared/operation-history.js`.
The fleet uses this component with a host selector. A late response from a previous
host cannot replace the selected host's history or redirect a recovery request.
Unavailable workflow histories remain visible until a successful refresh.

Host setup inspection/acknowledgement records a human review of the retained
installation. It does not reconnect using old credentials, rerun SSH or change
the original failed/interrupted result. Mod, framework and management recovery
remain in their owning workflows with their existing safety checks.

## Global progress and recovery

Administrators request `GET /jobs?workflows=1` to add the checked native workflow
projection to the established jobs response. Plain `/jobs` retains its existing
shape and access. Delegated/read-only accounts cannot request the enriched form.
The same guard applies through remote host forwarding.

The application shell and fleet model opt into this projection. Native active
records appear in the common progress banner; fleet records retain their host
identity. Recovery renders only the source's advertised inspect, acknowledge and
scoped open controls. It does not invent generic retries or acknowledgements for
specialized recovery. Session changes invalidate pending approvals and callbacks.
An unavailable source leaves a visible operations attention indicator.

Native recovery does not become the generic job-recovery lock: a specialized
backup/mod/update recovery must remain able to run under its owning controller's
rules. Native active work still disables ordinary lifecycle submissions in the
browser. Server-side owning workflow guards remain authoritative.

## Remaining durability work

Shared management state now has explicit repositories and a checked transactional
storage backend; see [Management storage](STORAGE.md). Existing installations
retain JSON until explicit offline migration. Native workflow journals and their
multi-file archive publication remain separate. A publication failure can retain
an uncertain preparatory record for review. Specialized interruption policies,
terminal audit correlation and publication-failure recovery still need the full
platform review. The shared database does not by itself make application files,
Docker effects or native recovery journals one atomic transaction.


Host setup now publishes its terminal state only after the final repository save.
An older history review queued during that save cannot overwrite the new outcome.
A failed final save leaves an interrupted record and fences new setup until
storage has been repaired and the retained host reviewed. That review does not
rerun SSH, reconnect with retained credentials or rewrite the original result.

## Worker ownership and collection

A Docker worker being stopped does not establish that its owner has consumed its
result. Instance-owned software and preview workers remain under their native
workflow's cleanup/recovery rules. The host sweeper does not collect them from a
worker label alone.

Host storage and retained-storage requests reserve a `workerReceipts` entry in
the active host job before container creation. It records the immutable container
ID and moves to `collected` only after the owner has read its exit/result or
failure. Background collection requires exactly one matching receipt in a
finished succeeded/failed job, no required recovery, and the same exited
container, name, instance and exit code. Created, active, replaced, ambiguous and
unrecorded workers remain held for their owner's review. The sweeper never
forces removal or deletes volumes. Explicit owner cleanup uses the immutable
container ID. Older unrecorded helpers are not silently adopted.

## Failure diagnostics

`core/operation-errors.js` provides the public reason/action contract used by
ordinary operations, migrations, storage workers and coordinated management
updates. `core/management-errors.js` remains a compatibility facade. Explicit
`OperationFailure` codes use fixed catalog messages. Existing local `HttpError`
client rejections remain intentionally public, bounded and redacted; application
authors must not put raw Docker output, credentials or private exception details
in them. Known recovery outcomes use a public rejection with a separate private
cause. Unknown exceptions use a fixed public fallback.

Host/controller jobs retain a safe `failure` with a reference, phase and
`retained` flag. Private details live under
`operation-diagnostics/<source>-<reference>.json` in the owning management root.
The directory is owner-only (0700), files are private (0600), and links/changed
ownership are refused. Each record retains at most eight observations, preserving
the first four and latest four, with at most four bounded causes per observation.
Public operation/worker responses never contain these causes. Diagnostic storage
failure is reported as `retained: false`; it does not replace the original public
reason. Failed helper request evidence is kept if private retention fails.

Storage-worker failure records keep the existing version/error fields for older
owners. Additional reason and private-cause fields are owner-only transport; the
owner saves diagnostic evidence before helper teardown. Interrupted operations
still require their owning workflow's recovery review. Diagnostics do not infer
success or authorize replay.

If creation or teardown cannot be proven, the owning job retains a recovery guard
and its request evidence. A later container removal does not itself acknowledge
the operation's outcome. Successful owner teardown records `removed`; background
collection can recover a missed teardown only from a completed `collected`
receipt. Failed management inspections and metadata helpers also copy bounded
worker output into private diagnostics before ordinary helper cleanup can remove
its logs.
