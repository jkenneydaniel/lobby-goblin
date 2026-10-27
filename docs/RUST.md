# Rust module

Rust can run through the [single-host manager](FLEET.md), or as a separate
standalone Lobby Goblin installation described below. Existing Factorio accounts,
worlds, launcher names and storage paths remain supported. There is no game
switcher in an existing panel and no automatic import of an existing Rust server.

## Included

- Status from Rust WebRCON, plus Docker CPU/memory samples. Readiness also
  requires the owned image's completed-startup health proof. WebRCON can answer
  while the world is still initializing.
  The controller reuses one authenticated connection, correlates concurrent
  replies and destroys failed or idle sockets. Disconnected commands are not
  retried automatically.
- Start, save-and-stop and restart jobs, with interruption confirmation and a
  per-installation operation lock. Start waits up to ten minutes for completed
  startup and WebRCON. Save/stop and backup refuse an initializing world.
- Connected players, Steam IDs, ping and connection time. Player addresses are
  excluded. Read-only accounts can view overview and players.
- Administrator-only, bounded Docker logs with credential filtering.
- Administrator-only settings for name, description, player limit and autosave
  interval. Stop Rust before editing. Changes apply at the next start; unlisted
  `server.cfg` lines are preserved, and revision checks prevent stale overwrites.
  Map seed, world size, identity and ports are deliberately outside this editor.
- Complete identity backups: saves, maps, player databases (including WAL files),
  configuration and other regular files under `server/lobby-goblin-rust/`. Streamed
  `.tar.gz` archives include a manifest and per-file SHA-256 hashes. Verification
  checks archive integrity and inventory, not whether Rust can load the result.
  Download and verification are available from Backups. Scheduling defaults off;
  enabling it requires explicit acknowledgement of repeated interruptions.
- Separate panel accounts, single-use registration links and invitations,
  controller credentials, WebRCON password, containers, bridge network and storage.

## Prepare a new installation

Use Node.js 24+ and an absolute, **new** directory outside the Factorio checkout.
Its parent must exist. Preparation refuses an existing destination and does not
contact Docker, download an image, start a server or create a game world.
This preparation command accepts POSIX host paths on Linux/macOS; native Windows
path support is not implemented. The existing Windows Factorio setup is unchanged.

New installations use the first-party **linux/amd64** Rust image:

```sh
node panel/applications/rust/setup.js \
  --directory /absolute/path/to/new-rust-install \
  --url http://localhost:8088
```

The default is `ghcr.io/jkenneydaniel/rust-server:steam-lg.2`. An explicit
`--image` must select a Lobby Goblin versioned tag, optionally pinned by digest.
Third-party images are not accepted for new installations. Setup copies this
panel runtime into the new installation; later source edits do not update that
copy. The generated Compose file is a standalone project, not an override to
merge with Factorio. See [image migration](IMAGE_MIGRATION.md) before upgrading
an older Rust installation.

The generated layout is:

```text
new-rust-install/
  compose.yaml
  .env                         # Rust installation ID, digest, paths and port
  rust.env                     # Private game-side WebRCON password
  installation.json
  panel/                       # Source snapshot for verified updates and optional local builds
  data/server/lobby-goblin-rust/     # Rust identity; server binaries live in data/
  backups/archives/            # Rust archives only
  control/auth/                # Rust panel accounts/invitations
  control/controller/          # Jobs, schedules and verification records
  control/secrets/             # Separate controller token and WebRCON password
  control/registration-link.txt
```

Data, state and backup roots also have `.lobby-goblin-rust.json` ownership
markers. Keep them with this installation. The controller checks them **before**
initializing shared state, then validates game/instance labels, the pinned image
and the expected bind mount before Rust commands or container mutations.
Renaming/adopting existing containers or data is unsupported.

## Starting later

Starting is a separate operator action. No running installation was changed while
implementing this module. Review the generated files and host resources first:
[Facepunch's server guide](https://wiki.facepunch.com/rust/Creating-a-server)
describes substantial Rust memory/disk requirements. ARM hosts require amd64
emulation; the previous bootstrap image failed to boot on the tested ARM64 Mac. Use a
native x86-64 Docker host running Linux containers for Rust; this can
be Docker Desktop on Windows. The preparation command above still requires a
Linux/POSIX filesystem, such as a dedicated WSL installation on Windows. See the
runtime evidence below.

From the **new Rust installation directory**, an operator can validate the file
without starting anything:

```sh
docker compose config --quiet
```

To actually install and run the new stack when ready:

```sh
docker compose pull
docker compose up -d --no-build
```

The image digest pins the bootstrap image, not the Rust build downloaded by
SteamCMD. Record the installed Steam build ID when reviewing updates.

On first launch the first-party image downloads Rust through SteamCMD. Later
starts reuse the installed binary without update checks, heartbeat restarts or
unmanaged framework installation. Frameworks selected through Mods are recognized. Existing worlds with missing binaries are refused rather
than silently downloading a newer game. Fresh independent snapshot clones carry
an explicit one-time installation marker. The Rust module rejects Factorio update
jobs; future Rust game-build updates still require separate review.

The panel binds to loopback port 8088 by default. Game/query UDP ports default to
28015/28017; WebRCON 28016 and the controller are not published to the host.
Configure an unused port if another Rust server already uses those game ports.
For deliberate LAN access, edit `RUST_PANEL_BIND`, `RUST_PANEL_HOSTS` and the game
address in the generated `.env`, then use the matching panel address. Protect
remote access with HTTPS. WebRCON is unencrypted only on the private bridge.
The Docker socket gives the controller host-level Docker privileges; it runs as
root to read Rust-owned databases. The web service has no socket or game mount
and runs with the setup user's UID/GID.

Open the private link in `control/registration-link.txt` to create the first
administrator account. It expires after 24 hours. To issue a replacement using
the copied runtime, run from the Rust installation directory:

```sh
PANEL_INIT_DIR="$PWD/control" PANEL_URL=http://localhost:8088 \
  node panel/init.js --registration-link
```

Treat `.env`, `rust.env`, `control/` and backups as private. Do not publish them.
If manually rotating WebRCON, change both `rust.env` and the password secret
together and recreate only this installation's affected containers.

## Managed software setup and recovery

New managed fleet installations expose **Software** to users with image-change
permission. It shows the recorded Steam build and current setup operation.
**Prepare and start Rust** installs once and then starts; opening the screen
never downloads or updates software. Existing installer-based servers keep their
current delivery method and are not converted automatically.

**Check Steam updates** explicitly resolves a build. Review its exact selection
and framework before applying. Applying saves/stops Rust, retains the previous
software and complete world together, then validates the target. Reviews expire
and cannot silently select a different build. Modded updates require the existing
framework and executable-mod permissions as well as software/lifecycle access.

After an interruption, review any blocked operation in **Operations**, then
**Inspect recovery** in Software. Stop Rust before a paired restore; a retained
metadata-only update check can be closed while running. Recovery restores the
matching earlier software/world/settings/mod data and retains newer data
privately. Initial setup recovery resumes preparation without starting Rust.
Cancellation stops retained preparation; inspect again before recovering. Session
expiry returns to sign-in and never resubmits an earlier operation.

Factorio continues to use its existing **Settings → Updates** flow and official
headless source. See the [minimal application guide](ADDING_AN_APPLICATION.md)
for small image-owned applications that need no game-specific adapter.

## Backup consistency and recovery

For a running Rust server, the module preflights the identity, asks `server.save`,
then requests a graceful Docker stop with **no kill timeout**. The selected image
has a signal handler that performs its Rust shutdown sequence. The controller
requires a stopped, non-OOM container with exit code zero before copying files.
The owned supervisor recognizes Rust's self-termination only after its own
acknowledged save, observed save completion and explicit game quit message;
unexpected kills and crashes remain failures.
An unreachable WebRCON or failed save prevents the stop/copy; a hanging shutdown
fails the request rather than escalating to a forced kill. Check status/logs and
resolve it manually. There is no force-stop button.

The identity is inventoried again while stopped. Copy/verification failures
attempt to resume a previously running server; failures to resume are reported
as failed jobs. A server already stopped stays stopped. A successful backup job
means its archive was published/verified and a previously running Rust server
answered WebRCON again. It does not prove a successful game-load restore.

Streaming avoids the Factorio ZIP memory/size ceiling. Bounds remain: 8 GiB minus
one byte per file, 64 GiB of identity data, 20,000 files, nesting depth 32 and
USTAR paths (100-byte leaf and 155-byte prefix). Symbolic links and special files
are rejected. Vanilla archives retain the version 1 identity-only format.
Version 2 modded archives also include `mods/carbon`, `mods/oxide` and `mod-state`:
plugin sources, configuration/data, exact active framework DLL/loader files,
downloaded framework packages, vanilla originals and interrupted-install recovery
records. Rust/Steam binaries themselves remain outside these archives. A modded
backup is refused by the shared world-cloning library rather than dropping its
mods; use complete recovery below.

Scheduled archives use the shared count retention rules, preserving the newest
two and the most recent verified backup. Manual archives are retained by default.
The Rust UI does not expose age-based deletion or automatic restore. If the
controller/host crashes during a backup, Rust may remain stopped; the interrupted
job is recorded on controller restart. Inspect it and resume Rust explicitly.

For recovery, verify/download the archive first, then stop this Rust installation
and extract into a **new disposable** identity location. Validate Rust can load
it before deciding to replace the active Rust identity. Never extract into the
Factorio installation. The host manager has passed real snapshot-clone loading on Windows amd64;
verify a separate recovery copy before replacing any active identity.

## Mods and plugins

Use **Mods & plugins** as an administrator. Oxide / uMod is one framework option:
uMod's Rust download is Oxide. Carbon is the alternative; they are never enabled
at the same time. Vanilla removes managed framework patches and restores the
original game DLLs. Switching preserves both frameworks' plugin and data folders.
It does not translate framework-specific plugins or configuration.

The [live mod library](MOD_LIBRARY.md) provides **Browse**, **Installed** and
**Updates** for public uMod plugins. Each change requires administrator review.
Choose to leave Rust stopped, automatically save/stop/apply/start, or apply plugins
while Rust stays ready. Hot changes request load/reload/unload; inspect Logs for
compilation results. Updates preserve disabled state and plugin data/configuration.
There are no background plugin updates.

Open **Framework, uploads & configuration** for the existing manual tools below.

Stop Rust first, choose the framework and select **Review installation**. Review
shows the official Linux release/version and SHA-256 checksum. Confirmation pins
that download for 15 minutes. Archives are checked before files change; links,
unsafe paths and unexpected payloads are refused. Framework releases must match
the installed Rust build. Installing a framework does not update Rust through
Steam. There are no automatic framework or plugin updates. Start Rust explicitly
afterward and inspect its logs. A failed transaction restores previous files when
safe; otherwise startup is blocked until **Recover framework** restores them.

Upload the original `.cs` filename from an author you trust (maximum 512 KiB).
Plugins execute server code. These manual install/update, enable, disable and remove tools require
stopped Rust; previous sources are retained. Removal keeps plugin data/config.
Reload uses the selected framework's reload command while Rust is ready.
Existing plugin JSON configuration can be loaded and saved with stale-edit
protection. Configuration changes apply at the next start. Framework/plugin
compatibility and a successful compilation still require testing on your game.

The feature requires the published `steam-lg.2` image and a controller using the
updated Compose root mount / `RUST_INSTALL_ROOT`. New installations include both.
Existing `steam-lg.1` games continue working; updating source or the host panel
does not restart those games or automatically replace registered instance
controllers. Upgrade an existing instance's image and controller together during
a reviewed maintenance window after a verified backup. The panel clearly blocks
framework installation until both prerequisites are present. Unmanaged existing
frameworks and manually edited managed DLLs require reconciliation first.

### Complete modded recovery

Keep the original installation untouched while validating a separate recovery
copy with the same installed Rust build and compatible bootstrap image. Verify
the archive first. Extract it into a fresh staging directory, then copy:

- `identity/` to the new installation's `server/<identity>/`.
- `mods/carbon/` and `mods/oxide/`, when present, to its `carbon/` and `oxide/` roots.
- `mod-state/` to the new controller's private `state/mods/` location.
- The contents of `mod-state/backup-active/`, including the hidden
  `.lobby-goblin-mods.json`, to the new game installation root. This restores the
  exact active DLLs/loader and framework selection without another download.

Regenerate instance markers/credentials for the recovery installation; these are
separate from world data. Start only that disposable copy and verify the world,
plugin compilation and plugin data before replacing any active installation.
Backups contain executable plugin code and potentially private plugin data, so
keep downloaded archives private. The acceptance runner's `rust --fresh --mods`
mode tests native Carbon/Oxide loading, plugin execution/reload, modded backup
recovery and switching back to Vanilla in isolated Docker resources.

## Runtime acceptance

A separate standalone Windows x86-64 Docker test passed lifecycle, stopped
settings, backup/resumption, 41 status/player requests including bursts and idle
reconnect, and actual save recovery. Independent extraction verified all 30 files;
loading the backup restored the saved time marker and 819 entities. No human game
client joined. This standalone test is recorded separately from fleet acceptance
in [the detailed verification record](VERIFICATION.md).

Native Windows x86-64 Docker acceptance reached real WebRCON readiness and
completed saved identity backups, hash verification, snapshot publication and
independent clone loading on October 20, 2026. Both source and clone reported the
same map seed and size; credentials and volumes differed. See the
[detailed verification record](VERIFICATION.md) for exact checks and limits.

Earlier ARM64 Mac experiments failed in SteamCMD and Unity/Mono; ARM Rust remains
unsupported by the host manager. Its first version requires Linux amd64 containers.
Historical acceptance above used the previous pinned Didstopia image. The new
first-party image also installs the public game build separately on fresh setup. Future game-build compatibility needs separate
validation. Existing Factorio servers and worlds were not involved.

## Development evidence

`panel/test/rust-module.test.js` uses temporary identities and mock Docker/Rust
responses, plus a real WebSocket exchange bound to loopback. It covers ownership,
storage markers, lifecycle/save failures, settings/injection/revision rules,
archive inventory/checksums, resumption, retention and web permissions. Package
tests check Rust runtime/template/assets in both existing release formats.

```sh
npm ci --prefix panel --ignore-scripts
node --test panel/test/*.test.js
node panel/test/rust-ui-preview.js
```

The synthetic preview binds to `http://127.0.0.1:8090`; use `admin` or `viewer`
with password `rust-preview-password`. It uses the actual shared web/controller,
account and archive code with synthetic game/host transports. It cannot contact
the host Docker socket. Stop it with Ctrl+C to remove its temporary files.

Protocol references: [Facepunch WebRCON client](https://github.com/Facepunch/webrcon/blob/gh-pages/js/rconService.js),
[server configuration](https://wiki.facepunch.com/rust/Creating-a-server#servercfg).
The current image contract is documented in [the first-party image README](../panel/applications/rust/images/README.md).
