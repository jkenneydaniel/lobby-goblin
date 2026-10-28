# Management updates and recovery

The panel and local operator command update an intact managed installation's
management services together. It preserves application container IDs, images,
mounts, networks and start timestamps. Application storage, worlds, backups and
the snapshot library are never mounted by the metadata worker.

Windows, macOS and Linux hosts use the same coordinator inside their local Linux
Docker engine. Supported layouts include the current broker deployment and the
recognized legacy raw-socket fleet/agent deployment with owned metadata volumes.
Custom commands, mounts, unowned resources and active workflows fail validation.
An update preserves the existing profile; it never converts a legacy registry to
the broker or automatically migrates game images. Existing installation records
and original Compose files remain intact. Linux x86-64 container requirements are
unchanged; native ARM game support remains deferred.

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
update. The request accepts release versions and retained review IDs, never
browser-supplied commands, image references, sockets or installation paths.
The fixed detached helper gets the engine-side Unix socket, private named recovery
volume and one scoped progress directory. It has no network or game/library mounts.
The host's working-directory label is provenance only: a Windows drive path is
never mounted or interpreted as a Linux directory, and host POSIX ownership is
irrelevant. Broker-enabled web/controllers keep their existing credential boundary;
legacy controllers retain their existing daemon authority.

The recovery volume is `lobby-goblin-fleet-FLEET_ID-management-updates`. A matching
unstarted `lobby-goblin-management-lock-FLEET_ID` pins its reader image and binds
storage to the engine and fleet. Preserve both. Do not prune or manually delete
them: original specifications, snapshots, update records and startup receipts are
private recovery data. They are not exposed to application or web containers.

**Older versions need one host-side coordinated upgrade** to obtain this code.
v0.3.14-alpha's panel cannot launch this portable helper on a legacy installation;
Windows support cannot be retrofitted into an already-running old controller.
Use the matching new release's operator command below once. This uses the official
image, without a local map-preview patch or image overlay. Later updates use the
panel on Windows, macOS and Linux.

Retain the displayed update ID. If management remains reachable after an
interruption, use **Resume update**, or **Restore previous management** before
activation is committed. A committed update offers forward resume only. If
ingress or a held controller cannot reconnect, use the operator command below
from the matching release with the same ID and fleet. Completed CLI recovery
publishes a verified broker receipt after final cleanup so stale panel progress
cannot keep application changes blocked. A killed coordinator may leave a filesystem
lease requiring offline identity-bound inspection through `panel/storage.js`;
the panel never deletes that lease or retries an uncertain install automatically.
If Docker confirms that the initial review coordinator never started, **Reset
failed review** removes only that unstarted helper and permits another review.
An absent helper after an uncertain start is not proof that nothing ran; those
attempts retain their recovery guard and require operator inspection.
Progress journals under the broker state (or legacy host state) `panel-updates`
directory survive metadata rollback and are excluded from management snapshots.

## Operator command

Run from a reviewed source checkout with its Node dependencies installed. Select
the local Docker context and an already available, release-verified immutable
runtime image. Planning never pulls a mutable tag. Unix sockets on Linux/macOS
and local Windows named pipes are supported; TCP/SSH contexts are refused. The
native process uses the selected socket/pipe only to start the fixed coordinator
inside Docker. The coordinator uses Docker's internal Unix socket.

The fleet ID is shown by the owned host's `io.lobby-goblin.fleet` label (also
`FLEET_ID` in the original installation environment file). Use the same ID for
inspection and recovery. These single-line commands work in PowerShell and Unix
shells; substitute the checked release image digest and retained ID:

```text
node panel/management-update.js plan --fleet FLEET_ID --image ghcr.io/jkenneydaniel/lobby-goblin@sha256:IMAGE_DIGEST
node panel/management-update.js status --fleet FLEET_ID --id UPDATE_ID
node panel/management-update.js apply --fleet FLEET_ID --id UPDATE_ID --confirm
node panel/management-update.js resume --fleet FLEET_ID --id UPDATE_ID --confirm
```

`--engine ENGINE_ID` optionally pins the native command to an explicitly reviewed
engine. Every saved workflow always records and rechecks that identity. Recovery
can run while management services are down. An uncertain launch reports its
coordinator name and update ID; inspect them before retrying.

The original `--directory PATH --socket UNIX_SOCKET --engine ENGINE_ID` mode is
retained for existing host-directory update records. Recover an unfinished old
update with its original mode before enrolling the fleet. After enrollment,
new plans use `--fleet`; the anchor makes old directory planners fail closed
instead of creating a conflicting startup receipt. Never copy private records
between these modes.

Planning validates the actual image's capability manifest, registered instances,
service ownership and configurations, metadata volumes and protected application
identities. It creates a temporary unstarted image probe and private local plan;
it does not change installed services. It enrolls the dedicated recovery volume
and unstarted anchor when needed. Unknown/custom layouts, unavailable or
active workflows and changed identities require review.

Inspect the retained update with `status`. Use `resume` with the same arguments
as `apply` to reconcile an interrupted step. Before activation is committed,
`rollback` with the same arguments restores the previous management metadata and
services. After commitment, only forward recovery is permitted. These commands
require `--confirm`. The panel invokes the same workflow through the fixed
coordinator, without exposing private recovery records to web services.

Keep the Docker recovery volume (or original directory-mode `.management-updates`) private and retain its original specifications,
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
3. The broker when present, host, instance controllers and web service are replaced in order.
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

The installer and Fleet launchers read public runtime selection through a read-only,
socket-free helper. They check the retained engine identity and use an extra
Compose override without rewriting original configuration. A mismatched legacy/
broker layout is refused. Starting an installation also checks the retained engine identity. It refuses an
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
| Broker authority and credentials (broker profile only) | Broker state and credential slots; sockets excluded |
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

CI runs the panel-triggered flow with both broker and legacy profiles. Native
Windows named-pipe and Linux/macOS Unix-socket tests use isolated HTTP fixtures;
those transport tests are separate from actual Docker engine cutover acceptance.
They do not constitute a Docker Desktop deployment on a user host.

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

### Docker Desktop socket admission and diagnostics

Docker Desktop may report the controller's `/var/run/docker.sock` bind source as
`/run/host-services/docker.proxy.sock` (including on Windows). The coordinated
updater accepts this exact alias only for a Linux engine identifying itself as
Docker Desktop. Before review and again before cutover, it checks the existing
owned management service's socket is a Unix socket and makes a bounded read of
`/info` through it, requiring the same reviewed engine ID. Normal service ownership,
command, privilege, volume and mount checks still apply. Arbitrary paths, extra
bind mounts, other destinations and different engines remain rejected. The
original mount specification is retained in recovery records; no game container
needs to be recreated to normalize a controller socket.

Failed workflows expose a sanitized reason code and next step in the panel and
operator output. The private update record also retains that diagnostic and its
existing phase/pending step. Raw Docker output, saved environment variables and
exception text are not copied into public errors. Duplicate operation identities
are distinguished from unreadable histories and active/interrupted work; none of
these conditions bypass the updater's idle-workflow guard. See
[legacy migration history repair](STORAGE.md#legacy-automatic-migration-history).

Socket source evidence: the reported Windows inspection and
[Docker's Windows diagnostics](https://github.com/docker/for-win/issues/11300).
These regression fixtures verify admission logic; they do not replace a live
Docker Desktop acceptance test on each supported host platform.
