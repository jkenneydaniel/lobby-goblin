# Multi-game host manager

Fleet mode is a separate, opt-in Docker project. It never adopts an existing
Factorio or Rust installation, mounts its data, changes its ports, or restarts
it. Standalone `compose.yaml` remains available. The checkout template is `deploy/fleet/compose.yaml`; extracted releases retain
`fleet.compose.yaml`. Use it by itself, with its own `.env.fleet` and fresh identity. Do not merge Compose files.

The same panel can manage other game-host machines. **Hosts → Add host** supports
manual agent installation with a pairing code or automatic installation over
SSH. The agent handles ongoing operations and reviewed version alignment without
SSH. The panel holds a pairing-secured connection to each agent on a configurable
dedicated port (24443 by default); public, private and VPN addresses are supported.
See [remote host setup, networking and recovery](REMOTE_HOSTS.md).

v0.3.4 automatically migrates this manager's registered older images after a
verified backup and clean stop. It preserves each server's storage and previous
running/stopped state. Unrelated standalone installations remain outside its
registry. Read [migration and recovery](IMAGE_MIGRATION.md) before upgrading.

## Start

Docker Engine 26+ with Linux containers on an amd64 host is required by this
release. Factorio uses the first-party 2.0.77-fc.3 image; Rust uses the first-party
steam-lg.2 bootstrap and installs the Steam public server.
The game image references are resolved to registry digests before provisioning. Rust downloads the
Steam public branch separately, so its installed game build can change on a
fresh installation. Rust snapshot recovery across game-build updates remains a
compatibility limitation; the reviewed bootstrap digest alone does not pin that
build. No player-to-server network join is asserted by automated runtime tests.
Game images are pinned; arbitrary images, remote Docker daemons and ARM Rust
provisioning are outside this version.

Run the launchers from the repository or release root. They resolve that root
when launched from another directory.

Windows: `./scripts/fleet/Fleet.ps1 -Address <your-LAN-address>`.
Mac/Linux on amd64: `FLEET_ADDRESS=<your-LAN-address> sh ./scripts/fleet/Fleet.sh`.
Use `-BuildOnly` or `--build-only` to build without starting the manager.
The scripts generate a fresh ID in ignored `.env.fleet`, pull the published runtime image,
start only the separately named host manager, and show its private one-time
administrator registration link. The default panel port is 8082. No firewall or
Docker Desktop configuration is changed. The address must match an allowed
hostname; game and panel ports default to all interfaces for LAN use.

The manager has a new account database. Existing standalone accounts are not
copied. Existing administrator and read-only roles apply to all local and paired
servers in this host manager. Invitations can also create **Assigned servers**
accounts with no initial server access. Administrators explicitly assign each
server and its tools in Accounts. Local and remote host scopes are independent;
see [server permissions, audit history and isolation](ACCESS.md).
Keep the invitation private; it expires after 24 hours. It is stored at
`/web-state/registration-link.txt` in the controller for an interrupted setup.

## Create and manage

Choose Create server, host, game, name, CPU, memory, player limit and an optional seed.
Rust also offers map size. Port allocation starts at UDP 35000 and checks Docker
port use; Rust gets a separate query port. Port clashes outside Docker fail
creation safely. RCON is never published. Each server has its own volume,
private network, game container, controller, generated secrets and operation
lock. Resource limits are applied to games and controllers; the memory budget
includes 1 GiB per controller and must leave at least 2 GiB for the host manager.
Existing host workloads need their own headroom when choosing this budget.

Open server uses the existing game-specific controls under an explicit server
URL. Multiple tabs remain independent. Factorio keeps worlds, previews/maps,
settings, players, logs, saves and backups. Rust keeps lifecycle, settings,
players, logs, Carbon/Oxide, plugins and verified complete backups. Existing
registered controllers and game images need a separately reviewed upgrade to
enable mods; updating the host manager does not restart them. Standalone panel/image installation
updates are refused in managed mode. Agent-only management services have their
own reviewed updater; game-controller/image upgrades and full-panel manager
updates remain separate operations.

Creation progress appears under Host operations. Rust's first Steam download can
take several minutes. Opening its panel shows logs while the game's initial
start job runs. Interrupted or failed creation preserves resources and storage
for inspection; no world is deleted automatically. A manager restart marks host
jobs interrupted and preserves registered servers. Game restart policy follows
the creation setting; manually stopped `unless-stopped` games remain stopped.

## Host memory settings

Open **This host’s settings** in the host manager to see the configured budget, total
allocated memory, remaining allocation capacity, Docker memory capacity and each
server's game/controller limits. These are configured allocations, not current
RAM use. Stopped and incomplete servers count; removed servers do not. Every
managed server includes a separate 1 GiB controller allowance.

Administrators can save a whole-number budget without restarting games or the
manager. Changes persist in the fleet registry volume and override the initial
`FLEET_MEMORY_GIB` environment default on subsequent starts. Other administrators'
changes require reloading a stale draft before it can be saved. Changes are
blocked during host operations, below existing allocations, or above Docker's
memory capacity minus 2 GiB (up to a maximum budget of 128 GiB). Leave additional
headroom for other workloads. Docker/WSL limits and individual server memory
limits are managed separately. Read-only accounts can view allocations.

## Snapshot library on each host

Publish snapshot first asks the source controller for a completed, verified
backup. Factorio confirms a save; Rust saves, stops, archives and resumes. The
library then copies only immutable backup content into a separate library volume.
The combined library labels each snapshot's host. Cloning stays on that host;
cross-host transfer is not implemented.
Factorio snapshots contain its active world ZIP and mod files. Rust snapshots
contain the identity's world and player databases, maps and related files, but
exclude the entire `cfg` directory. Neither format copies server configuration,
RCON passwords, panel accounts, controller tokens, or access lists.

Rust backups that contain mod/framework state are refused by this world-only
library, preserving them for complete recovery rather than silently omitting mods.
See [Rust recovery](RUST.md#complete-modded-recovery).

Every snapshot has a manifest containing the source, reviewed image, file sizes
and SHA-256 hashes. Publication uses a temporary directory and atomic rename.
Cloning verifies the manifest and every file, checks game/image compatibility,
and copies content into a new server volume. Rust clones preserve the source
map seed/size so the matching save loads. New name, configuration and generated
credentials belong only to the clone. Source and clone then evolve independently.
No writable world is mounted by two game servers. A snapshot remains available
when its originating server is removed.

To bring a standalone Factorio world into the library without adopting its host,
download a save through its existing panel, upload it through a new managed
Factorio server's Worlds screen, switch that new server to the uploaded world,
then publish it. Match game version and mods. Standalone data is never mounted.

## Removal and recovery

Remove server requires its exact name. It asks the controller to save/stop and
requires a clean exit before removing game/controller containers and the private
network. Its data volume and published snapshots are retained. This version has
no automatic retained-volume purge or adoption UI. Never use global Docker prune
commands for server removal. Back up both the fleet state and snapshot library
volumes; registry state contains generated per-server secrets and is private.
The web container has no Docker socket or game volumes. The trusted host and
instance controllers have Docker access, but operations validate fleet/instance
labels and the exact volume/subdirectory before acting. Only host-created
resources can be managed. Snapshot permissions and server administration share
the fleet's administrator role.

## Scoped container cleanup

Every minute, the controller examines only this fleet's stopped helper containers
and completed migration originals. Instance registration, ownership labels,
immutable IDs, expected data mounts and completed backup/migration records are
rechecked before removal. Active operations and interrupted migrations are kept.
Deletion is non-forced and never deletes volumes. Normal stopped game servers,
unrelated containers and unknown historical resources remain untouched.

## Development

Use Node 24 and `npm ci --ignore-scripts` in `panel/`, then `npm test`. Unit tests
use disposable directories and a fake Docker API. Real acceptance must use a
fresh FLEET_ID, unique local image tag, loopback panel/game binds, high ports,
and only owned disposable volumes. It must create both games, retain two
independent same-game volumes, publish/clone and check hashes/credentials, open
both server URLs and prove unrelated resources are refused. Never run acceptance
through the production Compose project. See `docs/VERIFICATION.md` for recorded
results and limitations rather than treating configured tests as completed work.

## Docker isolation in new definitions

Fresh managed hosts use a local Docker broker; neither the host manager nor an
instance controller mounts the daemon socket. Credentials and instance
permissions are enforced outside game controllers. Existing installations retain
their historical definitions until an explicit reviewed upgrade. Broker-enabled
hosts require operator-reviewed management updates instead of the legacy
socket-bearing agent helper. See [the isolation and upgrade contract](ISOLATION.md).

## Snapshot library and removed servers

Removed servers leave the active server list. Their registry identity and original
volume are retained for operator recovery and are listed separately under
**Snapshot library → Removed servers · retained storage**. Removing a server never
purges that volume. Old removed records also disappear from the active list after
upgrading the panel.

The removal dialog defaults to **Publish a snapshot to the library before
removal**. The host saves and stops the selected server, waits for a completed backup,
publishes and verifies its snapshot, then removes the server containers and network. A failed snapshot
prevents removal and leaves the server stopped, with its resources intact. For an incomplete installation or a server that cannot publish a
cloneable snapshot, an administrator can uncheck this option and retain the
original volume for operator recovery. Historical API clients that omit
`publishSnapshot` retain the previous removal behavior.

Administrators can inspect a snapshot's verified inventory and hashes, download
its manifest, create an independent server on the source host, or confirm deletion
of the selected library copy. Snapshot deletion does not delete source backups,
cloned servers, or retained source volumes. Inspection and deletion are scoped to
the owning host; collection reads remain available to read-only accounts. New
inspection/deletion routes require an updated host agent.

These are saved-world snapshots. Private management-update recovery metadata is
managed by the [operator update workflow](MANAGEMENT_UPDATES.md).

New Factorio servers can explicitly choose runtime software installation in the
creation dialog. The bundled image remains the compatible default. Runtime
servers manage Factorio versions independently of their image and clone snapshots
with an exact software receipt. See [Factorio runtime software](FACTORIO_RUNTIME.md).


Storage workers can read private game-owned backup files while retaining their
existing network isolation and three scoped storage mounts. Snapshot publication
errors identify permission, disk/quota, missing-file, archive-validation or memory
failures when available. If a requested snapshot fails, removal stops before
container/network deletion; the server data volume is always retained. Review
the failed operation before retrying. Retrying removal may stop the selected
server as part of the normal save/stop sequence.


Rust uses procedural seeds up to 2147483647 ([Facepunch reference](https://wiki.facepunch.com/rust/creating-a-server)). New Rust registrations and random seeds use the package's supported range of 1–2147483647; Factorio retains its uint32 range. Older panels could register larger uint32 seeds which Rust clamped to 2147483647. Snapshot publication accepts that specific legacy overflow only when the verified backup contains a save matching the clamped seed and the registered world size, and records the effective seed in the snapshot. Independent copies therefore use the seed of the backed-up world. Unrelated seed/size mismatches still fail. This does not rewrite existing registrations, backups, game settings or worlds, and does not retry a failed removal.
