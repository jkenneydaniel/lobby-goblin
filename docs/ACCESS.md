# Server access, audit history and isolation

This describes the uncommitted product-foundation changes. Editing these sources
does not upgrade an installation or change its running games.

## Accounts and assignments

Existing administrators retain access to the whole installation and all paired
hosts. Existing read-only accounts retain their existing installation-wide read
access, including each game's historical restrictions. They are not automatically
converted into restricted accounts.

Invite a new **Assigned servers** account, or explicitly change an existing
account to that role. It starts with no server access. In **Accounts → Server
permissions**, choose the account, server and permitted tools, then confirm.
Every assignment needs `server.view`; no wildcard or host-wide grant exists.
Account and host administration, server creation/removal, snapshots, panel/agent
software updates, general operation recovery and mod-provider credentials remain
administrator-only. An account can still change its own password, inspect its own
sessions and sign out other sessions.

| Permission | Access |
| --- | --- |
| `server.view` | Assigned-server list, status, worlds/players and operation activity |
| `server.operate` | Start, save, stop, restart and announcements supported by the game |
| `logs.read` | Game logs |
| `settings.read`, `settings.write` | Read or change game settings |
| `worlds.manage`, `worlds.download` | Create/upload/switch worlds, or download world saves |
| `players.manage`, `console.execute` | Player access, or supported administrative commands |
| `mods.manage` | Executable mods, Rust frameworks/plugins and their configuration/recovery |
| `images.change` | Review/install supported game version or image changes |
| `backups.read` | Archive list, health and policy visibility |
| `backups.create`, `backups.download`, `backups.restore` | Create/verify, download full archives, or restore where supported |
| `backups.schedule`, `backups.cleanup` | Automatic backup settings, or retention review and deletion |

Give `settings.read` with `settings.write` to expose the settings form. Give
`backups.read` with the backup tools to expose archive selection and policy forms;
give `logs.read` with `console.execute` to expose the console. A permission never
enables a feature the selected game or installation does not support. Managed
fleet game-image replacement and Rust automatic updates remain unavailable.

Saved archives can be filtered locally by a literal, case-insensitive name fragment
and their existing verification label. Counts cover the loaded list; finding a
match does not verify it or establish restore suitability. Clear filters resets
name/state, while Escape clears only name. Local filtering leaves schedule and
cleanup drafts/reviews intact and grants no additional actions. Choices survive
archive refresh within that mounted workflow and reset when it is disposed.

### Package permissions

The package's `contract.js` owns its permission names, labels and action/endpoint
bindings. Its `presentation.json` and custom interface use the same grants. The
shared account editor discovers these declarations; no game-specific permission
list lives in the account system.

| Package permission | Access |
| --- | --- |
| `application.factorio.map.view` | Saved map, terrain thumbnails, map-refresh status and live player positions |
| `application.factorio.map.generate` | Request a fresh map export from the saved world |
| `application.factorio.map.pins` | Add and remove shared map pins |
| `application.factorio.map.tracking` | Enable or disable live tracking, including its existing confirmation/backup workflow |
| `application.rust.framework.manage` | Review, install and recover framework changes |
| `application.rust.plugins.manage` | Catalogue reviews/installs/recovery, plugin uploads and plugin enable/disable/remove/reload |
| `application.rust.plugins.configure` | Read and change plugin configuration |

Each Rust package permission also requires `mods.manage`. A package permission
alone cannot authorize executable changes, and `mods.manage` alone cannot
authorize the Rust tools above. The plugin catalogue uses the same plugin grant
as manual uploads. Framework management, plugin management and configuration can
be delegated independently. Catalogue credentials remain administrator-only.

Existing administrator and installation-wide read-only roles retain their
historical behavior. Stored assignments are not rewritten: assigned-server
accounts need explicit new grants for these newly separated features. In
particular, `server.view` no longer exposes Factorio's map to assigned accounts,
and `worlds.manage` no longer permits map generation, pins or tracking. Give
`application.factorio.map.view` alongside the desired map tools to expose their
screen. Give `mods.manage` alongside the desired Rust package grants.
Draft terrain previews stay part of world creation and retain `worlds.manage`.

Mod and image grants authorize executable code and can include reviewed
stop/apply/start workflows, independently of the ordinary lifecycle grant. Grant
them only to people trusted with that server's code and data. Full backup archives
can include private settings and mod data. Restoring settings or plugin state is
also a powerful operation. These are capability boundaries within a trusted
installation, not a sandbox for mutually hostile customers.

Assignments use an exact `standalone`, `/servers/<id>` or
`/hosts/<host-id>/servers/<id>` key. A matching server ID on another host grants
nothing. The web service checks assignment before looking up a server or serving
its scoped assets, then checks the method, endpoint and job action before
forwarding. Unknown actions and routes are denied. A member's fleet list contains
only explicit public fields for assigned servers, without host inventory,
controller tokens or RCON credentials. Actors come from the authenticated session.
For image-only requests, trusted internal context reaches the controller and the
updater verifies the **saved plan's kind** before backup or worker effects. A
client-supplied kind cannot convert a panel-update plan into a game update.

Account changes are serialized, require confirmation, protect the last
administrator and invalidate affected sessions. Permission edits require the
current revision so two administrators cannot silently overwrite each other.
Roles and grants are re-read on each request. A request already authorized and
in flight is not cancelled by a later revocation. Existing account JSON remains
readable; `member`, `grants` and `accessRevision` are additive fields. Removing or
changing a role clears its old assignments. Older panel versions do not implement
these permissions: do not roll back to one while relying on delegated access.

## Audit history

Administrators can open **Accounts → Audit history** to search requests/access
changes or inspect operation outcomes for the current host/server. Pages include
actor, action, scope/target, time, outcome and associated operation ID when known.
Permission edits record the before/after roles and assignment changes. Accepted
requests and eventual job outcomes are separate events.

`audit.json` lives beside the web account store and in each controller's existing
state directory. Fleet child web panels share the parent's writer. Each store
keeps up to **10,000 events**, independently of the shorter operation history.
Pagination and the UI expose when older events have expired. Remote-host
controller histories stay on that host; this is not a central cross-host log
aggregator or an external audit exporter.

Writers serialize appends and atomically replace private mode-0600 JSON. Entries
have sequential numbers and a SHA-256 previous-entry chain, verified on load;
retention keeps an explicit anchor. Only fixed metadata fields are accepted:
passwords, tokens, invitation URLs, request bodies, query strings, plugin source,
game file contents, upstream error text and operation results are excluded.
Operation IDs can correlate a request with the job journal without storing its
inputs. Keep audit files private and include them in operational state backups.

Mutations must save a started event before submission. A failed initial audit
write prevents submission. The HTTP response is held until its outcome is saved;
if that write fails, the response says the action may have completed and asks for
status/history review. The started entry remains. A lost process or response does
not authorize replay. General jobs also persist their eventual result and
recovery review through the audit writer; audit failure leaves review required.
Specialized update, host-setup and mod transactions retain their existing
recovery journals; their request acceptance is audited, while specialized final
results remain available in their own operation/status views.
Authenticated access denials are recorded. High-volume ordinary reads are not a
complete access log, and rejected pre-authentication transport requests are not
all recorded.

The chain detects accidental edits or partial corruption. It is **not** a signed,
externally anchored or tamper-proof record: a privileged filesystem writer can
rewrite it. Stores use the existing single-process JSON model without fsync or
multi-writer coordination. No power-loss or multi-replica durability guarantee is
made. Do not delete an invalid history to bypass its failure; preserve it for
administrator investigation.

## Isolation boundary

Managed instances retain distinct data volumes, networks, credentials, controller
tokens and operation locks. Controller/remote routes are checked against the
selected game's exact HTTP-method contract. The managed Docker adapter checks
fleet/instance labels and the expected data subpath, then forwards container
operations using the inspected immutable ID. Arbitrary Docker endpoints, image
inspection outside the owned game, privileged exec and method confusion are
refused.

Game preview workers use the owned game image and one owned working subpath.
They have no network, extra mounts, host namespaces, devices or socket access.
Unreviewed HostConfig and volume-driver options are refused; memory is bounded
at 2 GiB, CPU at one core and process count at 256. Existing capability drops and
no-new-privileges remain applied. These checks do not change installed service
definitions or their existing worlds.

The subsequent [Docker broker stage](ISOLATION.md) moves daemon access out of
newly defined managed controllers and enforces their contracts in another
process. Existing and standalone installations retain their legacy socket access
until a separately reviewed upgrade. This adapter alone remains application-level
fencing. The broker still has host authority, and game/mod code still shares the
host kernel. Mutually hostile workloads require a separately reviewed host/VM
boundary and adversarial disposable-host acceptance. Neither stage claims hostile
multi-tenant hosting readiness.

See [architecture](ARCHITECTURE.md), [security scope](../SECURITY.md) and
[local verification](verification/access-audit-isolation.md).
