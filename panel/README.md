# Panel features and architecture

Lobby Goblin v0.3.4-alpha runs as two containers built from the same image:
a browser-facing web service and an internal controller. A third container runs
the selected game. See the [root setup guide](../README.md) before starting.

The optional [host manager](../docs/FLEET.md) creates isolated servers and shares
verified world snapshots through one account/session system. It also connects
[remote game hosts](../docs/REMOTE_HOSTS.md) through manual pairing or SSH setup
on a dedicated, configurable port (24443 by default). It
offers a host selector during creation and reviews matching agent updates.

The features below describe the Factorio module. Rust has its own
[controls, installation guide and recovery evidence](../docs/RUST.md).

The shared core and built-in game modules are described in
[architecture and compatibility](../docs/ARCHITECTURE.md). Existing entrypoints,
configuration, URLs and persistent formats remain compatible.

## Mod library

Administrators can browse live catalogues, inspect installed mods and review
updates for Factorio and Rust. Choose to leave the server stopped or automatically
save/stop/apply/start; Rust also supports explicitly applying plugins while ready.
Factorio requires a restart. See [mod sources, account setup and recovery](../docs/MOD_LIBRARY.md).

## Accounts

First-time setup prints a private one-use administrator registration link.
Registered administrators can invite administrators or viewers from Accounts.
Viewers can inspect status, maps, worlds and sanitized logs; they cannot manage
the game or download full backups. Passwords use salted scrypt hashes; invitation
tokens are stored hashed. Sessions expire after eight hours or a web restart.
Users can change their password and revoke other sessions. Administrators can
change roles and remove users, with protection for the last administrator.

## Guided diagnostics

Administrators can open **Settings → Diagnostics**, including when the controller
is unavailable. Checks explain panel/controller reachability, Docker metadata,
container state, recent game readiness, ARM emulation and storage permissions/free
space. These probes only read metadata: no game commands, test-file writes,
container creation or restarts. Game readiness uses a recent normal status sample;
without one it stays unconfirmed. Open Overview then check again to refresh it.
Joining from another device remains a manual check.

The support report contains the displayed results and panel/controller versions.
It excludes account records, credentials, addresses, paths, world names, settings
and raw logs. Download it locally before choosing where to share it.

## World presets and drafts

World creation automatically saves one draft per administrator account after a
short editing pause; **Save now** flushes it explicitly. Wait for **Draft saved**
before closing. Unsaved or in-flight edits trigger the browser's leave warning.
Name, seed, stage, settings, unfinished advanced JSON and invalid inputs resume
across reloads, logins and panel restarts. The library offers **Resume draft**.

**Saved presets & draft options** saves up to 20 named, private custom presets,
loads a preset, removes one or starts a fresh draft. Presets retain exact validated
terrain/gameplay settings and the game image reference, excluding the world name,
seed and switching preference. Loading keeps the draft's current name and seed.
A different game image prompts compatibility review; it is not a compatibility
guarantee. Every resumed form and loaded preset leaves switching unchecked.

Concurrent saves use revisions. A stale tab cannot overwrite newer work: download
a draft copy from that tab, then reload to use the current saved state. Draft copies
are JSON recovery records for manual recovery; importing them is not implemented.
Successful creation clears only its submitted draft, preserving newer work.
Drafts/presets live in private files under the existing auth volume, independent of
game saves. Removing the account removes its saved setups.

## Server and worlds

The dashboard shows players, running/paused status, game version, world, seed,
playtime, recent saves and resource usage. Administrators can save, start, stop
and restart; edit server settings; manage players, bans and whitelists; send
announcements; and use a restricted set of administrative console commands.
Fresh status samples query players and playtime each time. Seed and binary
version are cached for up to 30 seconds, scoped to the container, image, process
start and world, and invalidated after operations or RCON errors.

Worlds contains save uploads/downloads, the world library, world switching and
new-world creation. Switching saves and backs up the active game before loading
the selected world, and attempts rollback if it cannot become ready.

The new-world editor exposes resources, terrain/climate, cliffs, map dimensions,
enemy rules/evolution/expansion, research costs, spoil time and pollution. Sliders
and numeric inputs share server validation. Advanced JSON can add supported
engine settings but cannot bypass the normal field bounds.

Start with the panel's standard 2.0.77 preset, or load settings from an isolated
copy of the current save. The preset specifies the exposed controls; omitted
engine tuning uses Factorio defaults. Copied settings retain advanced values.
Before generation, missing gameplay tuning is filled from the exact installed
game image through Docker's read-only archive API, including while it is stopped.
Settings exports execute Lua only in a disposable copy. Fresh worlds are never
scripted; individual generation choices can still affect achievement eligibility.

Automatic 1024-pixel previews use the visible seed, start immediately when the
editor opens, and update 900 ms after an edit. While rendering, the browser checks
for completion every 250 ms; queued previews use a slower 900 ms check. Invalid
fields and unapplied JSON pause updates. Gameplay-only changes
reuse the terrain preview. One isolated worker renders at a time with no network,
one generator thread matching its one-CPU/1-GB limit and a 60-second wait. There
is one pending draft per account,
up to eight queued accounts and eight cached images for ten minutes. Workers
are removed afterward; previews do not modify the active game or create saves.

## Backups

Full backups include worlds, configuration and mods. New archives are checked
for CRC integrity, nested save validity and required files. Verification confirms
archive integrity; it does not prove that every backup has been test-restored.
Restore creates a backup of the previous state and attempts rollback on failure.

Scheduled backups are optional. Their count limit applies only to scheduled
archives and can remove them before the age window expires. Count pruning runs
inside the backup operation lock after a successful scheduled backup.

The **Backups** page also offers age-based cleanup: choose a window of 1–3650
days (30 by default), review the exact files and estimated space, then explicitly
confirm deletion. Manual and pre-change archives are excluded by default and can
be included separately. Both cleanup rules preserve the newest two backups of
each type, the most recent archive with matching successful verification metadata,
and any recorded backup required for update recovery. Unrecognized archives,
symlinks, unfinished files, world libraries and game autosaves are excluded.
Age is based on archive modification time; protected copies may exceed the window.

Daily cleanup is **off by default**. Enabling it requires a current review and
confirmation of future permanent deletions. The controller checks each minute,
runs the first due cleanup when idle, then attempts cleanup at most once per
24 hours while enabled. It shares the operation lock with backups, restores and
updates, skips pending update recovery, and never sends game or Docker commands.
Each automatic attempt appears in activity; failures wait until the next daily
attempt. Manual cleanup is available even with daily cleanup off.

Cleanup reviews expire after 10 minutes or a controller restart. Changed files,
verification/protection changes or a saved policy invalidate a review. Settings
persist in `state/backup-retention.json` with revision checks for concurrent
administrators. Deletion also removes the matching validation records. Cleanup
is permanent; download any additional copies before confirming. Health shows
space, archive sizes, verification results, next run and warnings.

## Map

Saved explored Nauvis is exported from an isolated copy of a completed save.
The active game receives no Lua from normal map export. Automatic refresh follows
completed autosaves, manual saves, last-player disconnect saves and shutdown saves;
it does not recursively request another save. Pending exports are coalesced and
persist across controller restarts. Open maps check for updates every five seconds
and preserve pan, zoom and enabled layers.
Administrators can open **Map refresh settings** on the map to turn automatic
refresh off or choose a minimum interval of 0–1440 whole minutes. Zero preserves
the existing refresh-after-every-save behavior. A positive interval limits export
starts; newer saves replace queued work until the next permitted refresh. Settings
and the last automatic start time persist across restarts. This does not change
game autosave frequency, live-player polling or the manual Refresh map action.
Members need the separate **Configure automatic saved map refresh** permission.
Export helpers use lower CPU priority (`CpuShares: 128`) so the active game takes
precedence when CPU is contested. They can use idle CPU without a hard quota;
exports may take longer under load. The existing one-GB memory limit remains.

Maps support resources, buildings, railways, power, pollution, saved player
positions, chart tags and shared pins. Sampling and export limits appear in the
root README. Pins are scoped by world name and seed. Historical snapshots and
other-surface maps are not included.

The Enemies & bases layer shows saved enemy spawners (red diamonds), worms
(circles), and biters/spitters (small dots). These are snapshot positions, not
live tracking, and only cover the exported explored chunks. Markers stay visible
at overview zoom and can be selected for details. At the 80,000-object cap,
enemies replace resource entries first, then other objects; bases and worms can
also replace units. The cap and incomplete-map warning remain. Refresh old
snapshots after updating to include enemy units.

The browser indexes snapshot objects and chunks for viewport rendering and
inspection. Terrain is decoded on first view into one small texture atlas, using
row spans. Export limits remain 2,048 chunks, 80,000 objects and 24 MB; a faster
browser alone does not prove larger Factorio exports fit the isolated worker.

**Cancel draft** in the world editor discards the account's saved draft and
returns to the world library. It waits for pending draft writes and checks the
saved revision and draft identity, preserving newer work from another tab.
Saved worlds and presets are kept. It does not cancel a submitted Create world
operation, and a terrain preview already requested may finish in the background.
**Back to worlds** keeps the draft; **Start fresh** replaces it with a new draft.

Optional live positions update on demand every two seconds while a signed-in
browser views the map. They require per-world achievement consent and a backup.
World switches and restores turn tracking off and require fresh consent; ordinary
restarts of the same world preserve the setting. Stale telemetry is hidden.

## Storage and privileges

| Path | Contents |
| --- | --- |
| `data/` | Game saves, configuration, mods, logs and temporary isolated workers |
| `backups/panel-backups/` | Full backups |
| `backups/panel-worlds/` | Uploaded/generated/archived worlds and retained previews |
| `.panel-data/auth/` | Accounts and hashed invitations |
| `.panel-data/secrets/` | Internal controller key |
| `.panel-data/controller/` | Jobs, schedules, maps, pins and validation records |

The unprivileged web service has no Docker socket or game data. The controller
runs as UID 845, with the configured Docker socket group, no extra capabilities,
read-only container filesystem and no published port. Its fixed endpoints require
the internal key. Access to Docker remains powerful; see [security](../SECURITY.md).

Setup is a separate, explicitly invoked profile. It has no Docker socket or
network and writes only its mounted checkout. On Linux it assigns newly created
game/controller files to UID 845 and auth files to UID 1000. It does not recursively
change ownership of existing worlds or accounts.

### Game image sources

Settings → Updates retains the current source and supports both pinned Factorio
Tools tags and Lobby Goblin `<version>-fc.<revision>` tags. A same-version
source/revision change uses the same reviewed backup, compatibility checks and
explicit recovery path as game upgrades. Download/preflight failures do not
replace containers. See [the independent image guide](applications/factorio/images/README.md).
## Rust installations

The built-in Rust module uses a separate installation and panel. See
[Rust setup, operation and backup limits](../docs/RUST.md). Existing Factorio
installations keep their defaults and data layouts.
