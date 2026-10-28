# Management storage

The panel's repositories separate management data from application files and
Docker effects. Existing installations continue to read/write their established
JSON until an explicit offline migration selects the database. There is no
startup migration, automatic import, silent fallback or default-install change.

## Repository contract

`core/storage/document-repository.js` retains a snapshot's backend and revision.
A save checks that backend selection has not changed; transactional storage checks
the persisted revision before publishing. A conflict requires reload/review.
Account or operation callbacks are never replayed automatically. Legacy JSON
checks the previous byte hash under the shared filesystem coordination lease;
cooperating writers cannot both publish from the same stale revision. This
provides conditional single-document writes, not an atomic multi-file legacy
transaction. SQLite provides atomic related-document batches.

| Profile | Repositories | Legacy source |
| --- | --- | --- |
| accounts | Directory containing credentials, roles, assignments and invitations | `users.json` |
| controller | Jobs, schedule, backup retention | `jobs.json`, `schedule.json`, `backup-retention.json` |
| host | Local resource registry, remote pairing registry, host setup jobs | `registry.json`, `remote-hosts.json`, `host-setup-jobs.json` |
| all three | Validated retained audit chain | `audit.json` |

The audit repository verifies the current retained chain on every read. Its pure
metadata append can retry a bounded revision conflict without repeating an
application action. Registry/configuration state becomes visible in memory after
a successful save. Job reservation/checkpoint failure retains the existing
operation recovery behavior and prevents unrecorded side effects.

## Transactional backend

`sqlite-store.js` uses the bundled Node SQLite API without an additional runtime
dependency. The private regular database is `panel-state.sqlite`; the exclusive
`panel-storage.json` marker binds its identity, profile and reviewed migration
hash. Schema version, application identity and recorded migration checksum are
checked. Unknown versions fail while preserving the file.

Transactions contain bounded synchronous SQL and JSON values. A batch commits all
its documents or none. Revision checks reject competing writers, including two
processes which read the same old revision. Deletions retain revision tombstones,
so recreating a document cannot validate a stale pre-delete snapshot.

Rollback journaling (`DELETE`) and `synchronous=EXTRA` keep the storage model
simple for these bounded management aggregates. See the primary
[Node SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html),
[SQLite transactions](https://sqlite.org/lang_transaction.html) and
[synchronization reference](https://sqlite.org/pragma.html#pragma_synchronous).
This is not a multi-host database or a transaction around Docker/filesystem work.

## Reviewed migration

The internal `planStorageMigration(root, profile)` API reads supported bounded
regular JSON files and hashes the reviewed bytes. It validates domain versions
and the audit chain. It exposes no credential values in the plan.
`applyStorageMigration(plan, {confirm:true, offline:true})` rechecks those inputs,
imports the complete batch into a private prepared database, rechecks source
bytes and publishes an exclusive activation marker. Existing JSON bytes and all
unrelated application/world files stay intact. Failed activation can be retried
with the same plan/identity; changed inputs or another prepared plan require
review. Reentry validates both the marker and selected database.

Migration holds the same exclusive coordination lease as repository writes,
including Factorio's legacy draft writes. It waits for a cooperating writer and
then rechecks the reviewed bytes. The offline flag still means management
processes have been stopped: the lease does not stop already-running workflows
or old binaries which do not participate. No migration has been applied to an
existing installation. Do not remove a selected marker to roll back; old JSON
becomes stale after database writes.

## Module-owned related records

A reviewed module may declare `storage: {version:1, groups:[...]}`. Group contracts
bind an account-storage directory, namespace, UUID keys, data schema and decoder.
The module ID prefixes its namespace; groups cannot replace shared repositories,
follow links or traverse paths. Migration plans pin their data-only manifest and
input hashes. The selected store records that manifest; an undeclared module
repository cannot write to it. The operator tool loads registered built-in
contracts instead of accepting decoder code from a plan.

Factorio owns `applications/factorio/storage.js`. Saved drafts/presets remain separate
from credentials, but their records and account references can commit in one
transaction. Account deletion tombstones those related records in the same
batch. A failed child insert/delete rolls back the parent change. Original
legacy sidecars remain byte-for-byte intact after migration; recreating a user
does not reconnect that user to the old private data. Other application types
can add reviewed storage codecs without teaching the shared store their format.

## Writer coordination and interrupted locks

`.panel-storage-lock/owner.json` identifies a bounded writer/migration/export
lease. Reentrant metadata writes share that lease; inherited asynchronous work
cannot reuse it after release. A crash leaves the lease for explicit offline
review. PIDs are diagnostic, never a liveness check across containers. The lease uses
kernel-visible filesystem coordination, not per-request disk flushes; data
commits and activation/export manifests retain their separate durability
barriers.
Inspection records directory identity and a hash of owner bytes, including a
truncated initialization record. Recovery refuses a changed review, links or
unknown files. It never guesses that a writer is dead or automatically clears
its lock.

A confirmed commit remains successful if lease cleanup fails; this prevents
callers from overwriting durable data with stale in-memory state. A retained
lease fences subsequent writes and requires offline recovery. If an operation's
final persistence fails, its owning workflow retains uncertainty.

## Operator commands

These commands operate on management documents only. Paths below illustrate a
separate reviewed copy; they are not instructions to migrate a running install.
The root/profile are explicit, output artifacts are private and existing outputs
are never overwritten. No command calls Docker, stops a service or reads worlds.

```sh
node panel/storage.js status --root /review/auth --profile accounts
node panel/storage.js plan --root /review/auth --profile accounts --out /review/accounts-plan.json
node panel/storage.js migrate --root /review/auth --profile accounts --plan /review/accounts-plan.json --offline --confirm
node panel/storage.js export --root /review/auth --profile accounts --out /review/accounts-export
node panel/storage.js recover --source /review/accounts-export --out /review/recovered-auth --offline --confirm
node panel/storage.js lock --root /review/auth --out /review/lock-review.json
node panel/storage.js unlock --root /review/auth --review /review/lock-review.json --offline --confirm
```

Export takes a coherent transactional snapshot under a short coordination lease,
then writes private JSON documents and a final hashed manifest into a new folder.
Incomplete, changed, linked, unknown or unsupported records fail rather than
being omitted. Recovery validates every document before creating a new store,
retains account/grant revisions and instance references, and assigns a fresh
storage identity. It never overwrites an existing destination or changes the
source. Original application files, identity/definition markers, tokens and
native journals remain the responsibility of the full installation backup;
this export is a management-document recovery artifact.

Management-service quiescence, full-state backup/cutover and broker upgrade
integration remain part of the management lifecycle work. Native workflow
archive publication remains separate from the shared SQL transaction.
The database cannot establish game-save consistency; each application adapter
continues to own that barrier. The historical standalone updater refuses a
selected storage marker before engine commands or recovery copies: its live
file-copy rollback cannot safely snapshot this backend. Keep activation behind
the supported management lifecycle work; do not use the legacy updater to
bypass it.

## Verification

The storage repository/extension/coordination/recovery suites use disposable
directories and child processes for revision conflicts, partial commit rollback,
administrator invariants, audit integrity, process death and migration recovery.
They also execute the operator CLI, restore current credentials/grants/drafts and
registry identities into fresh stores, and reject altered or incomplete exports. Migrated real
controller/host code paths are exercised without an actual game or Docker engine.
Unrelated world sentinels and original JSON bytes are compared directly. These
checks establish local behavior, not a production migration or runtime acceptance.

## Legacy automatic migration history

Automatic image migration attempts now use unique operation IDs and retain
`migrationId: migration-034` for correlation. Older versions could record two
attempts as `migration-034`, making the application operation history unavailable
and correctly blocking management updates.

At host-manager startup, the application repairs only that known system migration
collision. It retains every attempt, state, phase, timestamp and recovery flag,
assigns distinct identities, updates each attempt's own operation envelope, and
records its original ID, registry hash and position. Before publishing any change,
it saves the complete original registry and identity mapping in a private
`migration-history-repairs/<registry-hash>.json` file. This can contain private
management data; keep it private. The repair uses the storage writer lease and
revision checks and works with JSON and selected SQLite storage. It does not edit
audit history, servers, migration journals, snapshots or worlds.

For maintenance without starting the manager, use the new release's runtime with
the **host management state only** mounted at an explicit root. Keep management
writers offline, then run:

```sh
node panel/storage.js repair-migration-history --root /path/to/host-state --offline --confirm
```

Within the packaged runtime the entry point is `/app/storage.js`. This command
performs no Docker or game actions. Interrupted attempts remain blocked until an
administrator checks and acknowledges their outcome in operation history. It
never infers that an earlier interruption succeeded because a later attempt did.
Unknown collisions, modified identities and ambiguous external references require
operator review and are left unchanged. Repeating a completed repair is a no-op.

Normal history writers enforce valid, unique operation IDs for controller jobs,
host jobs and host setup history. JSON writes, SQLite writes and related-document
transactions validate before publication; generated-ID collisions are also
refused before reservation audit/effects. Read paths remain compatible with
historical records so the documented repair can inspect them. Unknown duplicates
cannot be resaved or silently renamed. These checks add no storage schema version
or database migration and do not change idempotency/request-ID semantics.
