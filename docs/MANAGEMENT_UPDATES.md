# Management updates and recovery

The panel and local operator command update an intact, broker-enabled installation's
management services together. It preserves application container IDs, images,
mounts, networks and start timestamps. Application storage, worlds, backups and
the snapshot library are never mounted by the metadata worker.

This command does not adopt legacy/custom installations or migrate them to the
broker. Existing installation records and generated Compose files remain intact.
Ordinary startup without an operator update keeps its previous behavior.

## Updating from the panel

In **Updates → Update management services**, choose the management host and
review the displayed release. Review resolves the owned published runtime to an
immutable digest, validates the installation and shows the number of management
services and protected application containers. Confirm **Install management
update** within fifteen minutes. An expired review can be cancelled and repeated.

The fixed coordinator runs independently of the broker, panel and controllers it
replaces. The panel briefly disconnects and polls for reconnection. Sessions are
held in memory, so sign in again after the panel restarts; reopen Updates to read
the durable result. The same controls support paired remote hosts, including
aligning an older agent to the panel's installed version.

Only administrators with a valid session and CSRF token can start or recover an
update. The broker accepts release versions and retained review IDs, never
browser-supplied commands, image references, sockets or installation paths. It
derives the existing directory from the owned Compose controller and the worker
revalidates its intact installer manifest before any change. A private detached
helper alone receives the local socket, installation directory and one scoped
progress directory. It has no network or game/library mounts. It drops to the
installation owner's UID so the existing operator CLI retains recovery access.

**Installations older than v0.3.14-alpha need one host-side coordinated upgrade**
to obtain this broker capability. Their earlier broker intentionally cannot
launch it from the panel. Use the operator procedure below for that first upgrade.
Legacy/custom layouts and Windows named-pipe transport are still unsupported by
this coordinated path; they are never silently adopted.

Retain the displayed update ID. If management remains reachable after an
interruption, use **Resume update**, or **Restore previous management** before
activation is committed. A committed update offers forward resume only. If
ingress or a held controller cannot reconnect, use the operator command below
from the matching release with the same ID and directory. Completed CLI recovery
publishes a verified broker receipt after final cleanup so stale panel progress
cannot keep application changes blocked. A killed coordinator may leave a filesystem
lease requiring offline identity-bound inspection through `panel/storage.js`;
the panel never deletes that lease or retries an uncertain install automatically.
Progress journals under the private broker's `panel-updates` directory survive
metadata rollback and are excluded from management snapshots.

## Operator command

Run from a reviewed source checkout with its Node dependencies installed. Select
the existing installation directory, an explicit local Unix Docker socket, the
engine's literal identity and an already available immutable runtime image. The
command never pulls a mutable tag. Windows named-pipe transport is not supported
by this operator command; existing Windows installation behavior is unchanged.

```sh
node panel/management-update.js plan \
  --directory /absolute/installation \
  --socket /absolute/docker.sock \
  --engine ENGINE_ID \
  --image ghcr.io/jkenneydaniel/lobby-goblin@sha256:IMAGE_DIGEST

node panel/management-update.js status \
  --directory /absolute/installation \
  --socket /absolute/docker.sock --engine ENGINE_ID --id UPDATE_ID

node panel/management-update.js apply \
  --directory /absolute/installation \
  --socket /absolute/docker.sock --engine ENGINE_ID --id UPDATE_ID --confirm
```

Planning validates the actual image's capability manifest, registered instances,
service ownership and configurations, metadata volumes and protected application
identities. It creates a temporary unstarted image probe and private local plan;
it does not change installed services. Unknown/custom layouts, unavailable or
active workflows and changed identities require review.

Inspect the retained update with `status`. Use `resume` with the same arguments
as `apply` to reconcile an interrupted step. Before activation is committed,
`rollback` with the same arguments restores the previous management metadata and
services. After commitment, only forward recovery is permitted. These commands
require `--confirm`. The panel invokes the same workflow through the fixed
broker coordinator, without exposing private operator records to web services.

Keep `.management-updates` private and retain its original specifications,
operation records, active-runtime receipt and Compose override. They can contain
credentials and must not be copied into a support report. CLI output and panel
history contain only checked public metadata. A retained storage lease after an
operator process dies requires offline identity-bound lock review using
`panel/storage.js`; never delete it or the engine claim to bypass recovery.

## Update sequence

1. A filesystem lease protects the installation. An engine-owned claim also
   prevents a second operator using a copied installation directory from updating
   the same fleet. The claim container is never started and has no mounts or
   credentials.
2. The operator records intent before each mutation, stops public ingress and
   management writers, and rechecks workflows before stopping controllers. Game
   containers remain running. A fixed worker snapshots management metadata.
3. The broker, host, instance controllers and web service are replaced in order.
   Old management containers remain stopped until the outcome is confirmed. New
   services start held: health is available, ordinary requests and background
   work wait for activation.
4. The operator checks held health, workflows and protected application identities
   before durably committing activation. Earlier failures can restore metadata
   and restart the original services. Once originals restart, a retried rollback
   cannot overwrite their new activity with an old snapshot.
5. A pending desired-runtime receipt is written before activation. Each service
   records activation durably. Committed recovery inspects, restarts or recreates
   only its own replacements and finishes forward. A lost response never implies
   that the action should be replayed without inspecting its actual result.
6. Checked outcomes enter the common operation history and audit log. Failed
   publication is retried without rerunning the update. A complete private receipt
   and Compose override keep later installation starts on the selected runtime.
7. After confirmed success, exact stopped originals are removed so Compose selects
   only current services. Snapshots and private original specifications remain.
   Failed cleanup retains the confirmed outcome and returns `cleanupRequired`;
   `resume` retries cleanup only. Startup refuses unfinished updates or cleanup.

Starting an installation also checks the retained engine identity. It refuses an
unfinished update, pending receipt or altered override instead of reverting to
an older Compose image. There is no automatic migration or update on startup.

## Metadata and startup boundaries

`panel/management-runtime.json` declares the broker, storage and maintenance
protocols. The operator reads it from the actual immutable image, in addition to
checking source/runtime labels. Services use `PANEL_MAINTENANCE_ID` for held
startup. Loopback-only, bearer-protected status/activation endpoints are excluded
from panel/fleet proxies and application routes. Activation never submits an
application Start action. The read-only agent web service receives its activation
receipt through the operator's fixed metadata worker.

The worker has no daemon socket or network. Its mount vocabulary is fixed:

| Metadata | Scope |
| --- | --- |
| Host state, registry and operations | Fleet state volume |
| Accounts, settings and web secrets | Fleet web volume |
| Broker authority and credentials | Broker state and credential slots; sockets excluded |
| Instance state and credentials | Instance `state`, `updates` and `control` subpaths |

The worker preserves opaque bytes, modes and numeric ownership, including
selected SQLite databases and native workflow files. Bounded file/path checks
reject links, special files, nested filesystems, foreign ownership and retained
leases. A complete hash manifest is published last after durability barriers.
Restore validates the whole snapshot before replacement, requires stopped
writers and the recorded manifest hash, and can retry a partial restore. A
completed restore verifies its receipt instead of overwriting later changes.

## Verification

Source tests cover intent-before-effect, lost responses, pre-activation rollback,
forward-only activation recovery, private receipts, startup exclusion, engine-wide
operator exclusion, changed configurations, failed outcome/audit publication and
cleanup retry. The SSH host installer includes the new startup dependencies.

The opt-in `panel/test/management-update-runtime.mjs` uses a marked disposable
Linux engine, actual installer-generated Compose files and a fresh synthetic
application. It exercises CLI success, rollback, lost replacement/activation/
publication responses and management-process restart. Each outcome must preserve
application identity, start timestamp, mounts/networks, world bytes and the
original installation files. Only a completed result is acceptance evidence;
source tests and individual probes do not establish a complete image cutover.

No existing installation has been upgraded or published by this source work.
The complete foundation review and disposable runtime evidence are recorded in
[the completion ledger](verification/platform-completion.md). Production native
application acceptance remains separate from these synthetic preservation checks.
