# Setup on Windows, macOS and Linux

For a new multi-game host manager, use the [Lobby Goblin installer](INSTALLATION.md)
instead. It includes explicit Ubuntu Docker installation, local/hosted panel
choices and browser-based administrator onboarding. This page describes the
existing standalone Factorio setup, which keeps its LAN deployment behavior.

The setup tools require Docker with Compose v2, not a host installation of Node,
Python, Homebrew or PowerShell on Mac/Linux. They check the local Docker daemon,
Linux container mode and architecture, validate configuration, prepare data and
print the private administrator registration link. They do not install Docker,
change firewalls, install emulators or configure host startup automatically.

Before preparing private data, the setup container checks that its trusted CA
bundle parses correctly and that Docker, Compose and Buildx can run. An incomplete
image fails with a rebuild instruction instead of reporting successful setup.
These are local checks: setup still has no network or Docker socket, and offline
preparation works when its image is already available. They do not prove registry
access, Docker socket permissions or LAN reachability; the release build separately
tests a fresh registry request and a real restricted-worker build.

## Platform choices

| Host | Panel/controller | Factorio 2.0.77 and map workers | Prerequisite |
| --- | --- | --- | --- |
| Windows x86-64 | Native Linux amd64 container | Native Linux amd64 container | Docker Desktop, Linux containers |
| Intel Mac | Native Linux amd64 container in Docker VM | Native Linux amd64 container in Docker VM | Docker Desktop |
| Apple Silicon Mac (ARM64) | Native Linux arm64 container in Docker VM | Linux amd64 through Docker emulation | Docker Desktop with amd64 emulation |
| Linux x86-64 | Native Linux amd64 container | Native Linux amd64 container | Rootful Docker Engine + Compose v2 |
| Linux ARM64 | Native Linux arm64 container | Linux amd64 through host emulation | Rootful Engine + Compose v2 + amd64 binfmt/QEMU |

Allow roughly 3 GiB of free memory for the standalone stack and an isolated map
worker, plus disk space for worlds and backups. Large factories need more. Match
all clients to Factorio 2.0.77. New standalone defaults disable optional Space Age
mods for base-game client compatibility; existing mod choices are preserved.

These are configuration targets, not claims that every host has been tested.
32-bit x86/ARM, rootless Docker, remote Docker contexts and alternative container
engines are outside this release's setup support. Windows ARM64 follows the same
emulation requirement if its Docker Desktop installation supports Linux amd64.

The game remains pinned to 2.0.77 to match existing clients. The first-party image
and map workers invoke the x64 binary directly.
We explicitly select `linux/amd64` for the game and **all** disposable workers to
avoid mixing these execution paths. The Node services build for the daemon's
native architecture. Do not set `DOCKER_DEFAULT_PLATFORM=linux/amd64` globally:
that would also force the panel into emulation. Do not change `FACTORIO_PLATFORM`
to ARM for this release. Native Linux ARM game support would require a separate
game-version and worker-path compatibility change.

Sources: [Compose platform](https://docs.docker.com/reference/compose-file/services/#platform),
[Docker emulation](https://docs.docker.com/build/building/multi-platform/#qemu).
See also the [first-party image contract](../panel/applications/factorio/images/README.md).

## Guided setup

Download/extract the source into a local writable folder. Keep the entire folder
on a local disk; setup data and temporary map workers use bind mounts.

**Windows:** install Docker Desktop, start it using Linux containers, open
PowerShell in the extracted folder and run:

```powershell
./scripts/standalone/Setup.ps1
```

If Windows blocks downloaded scripts, review them first and use
`Unblock-File ./scripts/standalone/Setup.ps1` for that file. Do the same for `scripts/standalone/Start-Server.ps1` if
needed. No machine-wide execution policy change is required by this project.

**Mac:** install and start Docker Desktop. Double-click `scripts/standalone/Setup.command` in Finder
or open Terminal in the extracted folder and run:

```sh
sh scripts/standalone/Setup.sh
```

The root `compose.yaml` and `.env.example` remain stable in both Git checkouts
and released installations. Helper scripts resolve that root before accessing
`import/`, `.env`, data or backups. Release bundles retain root launcher names;
see [repository layout](REPOSITORY.md).

The source packager preserves executable permissions in its source directory;
some ZIP extractors drop them. If Finder cannot launch `scripts/standalone/Setup.command`, use the
Terminal command above. macOS may also require you to allow Docker to share the
folder containing this checkout.

**Linux:** install Docker Engine and the Compose plugin using your distribution's
[official Docker instructions](https://docs.docker.com/engine/install/), start
the service and ensure your normal user can access Docker. Then run:

```sh
sh scripts/standalone/Setup.sh
```

The Linux launcher detects the local socket group automatically. It expects
`/var/run/docker.sock`; Docker Desktop uses its VM socket instead. Do not run the
whole launcher as root to work around permissions.

Choose new world, import, or registration-link recovery. For import, first copy
your Factorio save ZIP into an `import/` folder at the repository root. Spaces in the
filename are supported. Setup validates and copies the ZIP, preserving its source.
For a new `.env`, guided setup asks for the host's reserved LAN IPv4 address or DNS
name; blank means localhost. Existing `.env` values are retained unless you supply
an explicit address. Setup does not guess which network interface friends use.

The launcher pulls the versioned public panel/controller/setup runtime; it does
not compile that image on the host. Explicit development builds remain available.

After preparation you can choose to start the stack. The default is **No**.
Once running, open the private registration URL printed by setup and create your
administrator account. The link expires after 24 hours. Owner registration opens
**Ready to play**, a resumable guide with game/first-save checks, exact client
version, and copyable game/panel addresses. It never starts or saves automatically.
If needed, explicitly choose **Save now** after the game is ready. Completion is
saved to your account; **Do this later** returns to Overview, and **Setup guide**
reopens it. Existing accounts are not forced through onboarding.

In the game, choose Multiplayer → Connect to address and use the displayed game
address. A localhost/loopback address only works on the host. Joining from a second
device is the way to confirm LAN access; local readiness cannot verify that.

## Direct commands

Mac/Linux:

```sh
sh scripts/standalone/Setup.sh --check
sh scripts/standalone/Setup.sh --new-world --address factorio.local
# OR, with a ZIP you have placed in import/:
sh scripts/standalone/Setup.sh --save 'import/Our factory.zip' --address factorio.local
# Start later, deliberately applying local source/config changes:
sh scripts/standalone/Start-Server.sh
```

Windows equivalents:

```powershell
./scripts/standalone/Setup.ps1 -Check
./scripts/standalone/Setup.ps1 -NewWorld -Address factorio.local
# OR:
./scripts/standalone/Setup.ps1 -Save 'import/Our factory.zip' -Address factorio.local
./scripts/standalone/Start-Server.ps1
```

Use your own reserved IP/hostname in place of `factorio.local`; that example does
not create DNS or mDNS discovery. Add `--start` / `-Start` to a setup command when
you deliberately want setup followed by stack startup. A rerun preserves existing
worlds/accounts; it does not create another world over existing saves. Create
additional worlds using the panel. `--registration-link` / `-RegistrationLink`
replaces setup/recovery invitations while preserving users and worlds.

`--check` / `-Check` validates prerequisites/config only, makes no files and starts
no containers. It cannot prove that game emulation, ports or LAN routing work.
It uses `.env.example` if no `.env` exists. Run `--help` / `-Help` without Docker
to see the available commands. The manual Compose commands below remain available for experienced users.

## ARM64 prerequisites and troubleshooting

Docker Desktop provides cross-architecture emulation. If available, its Apple
Virtualization framework/Rosetta option can accelerate amd64 execution on Apple
Silicon; available settings depend on your Docker Desktop version/VM backend.
Factorio simulation and preview generation can be slower under emulation. No
performance or capacity claim is made before running your particular world.

On a native Linux ARM64 host, amd64 execution needs host-level binfmt/QEMU
registration. The launcher reports this requirement but does not install it or
prove it by running a container. Follow your distribution's supported QEMU/binfmt
setup and the [Docker multi-platform guide](https://docs.docker.com/build/building/multi-platform/#qemu).
Buildx-only emulation is insufficient if the runtime daemon cannot execute amd64
containers. An `exec format error` usually indicates missing runtime emulation.

Other common issues:

| Symptom | Next step |
| --- | --- |
| Docker unavailable | Start Desktop/service and check local context and user access. |
| Remote context rejected | Select a local Docker context; bind mounts resolve on the daemon host. |
| Mount denied on Mac | Allow Docker Desktop access to the checkout folder. |
| Controller socket permission denied on Linux | Rerun setup to detect socket GID, then deliberately recreate services; review ownership before changing existing data. |
| Panel opens locally but friends cannot connect | Replace localhost in `.env`, apply with Compose, check host firewall and same-LAN routing. |
| Version mismatch in Factorio | Match all clients to 2.0.77; do not upgrade the server image alone. |
| Registration expired | Run setup's registration-link mode and use the new private link. |

## Network and startup

Allow the configured panel TCP port (default 8080) and game UDP port (default
34197) from the trusted LAN in your host firewall. No router forwarding is needed.
The optional Windows `scripts/windows/Configure-Lan.ps1` helper still targets **default** ports;
configure custom ports manually. Linux firewall tools vary by distribution, so
review the local policy before adding rules. On Mac, allow Docker's incoming
connections where requested. Direct connection is supported on every host;
the Windows LAN announcer remains Windows-only.

Restart policies apply after Docker starts. On Desktop enable its start-at-login
option if desired. On Linux enable Docker's service if desired. These launchers
do not register background tasks or change startup settings.

Optional Windows utilities are in `scripts/windows/`; they run only when invoked
explicitly and are separate from guided setup:

| Helper | Purpose |
| --- | --- |
| `scripts/windows/Configure-Lan.ps1` | Allow the default game/panel ports from the local subnet on Private networks; run as administrator if needed. |
| `scripts/windows/Configure-Autostart.ps1` | Enable Docker Desktop startup for the current Windows user; run while Docker Desktop is closed. Desktop startup still requires sign-in. |
| `scripts/windows/Start-LanAnnouncer.ps1` | Version-specific PC LAN discovery workaround; direct connection remains the primary path and Switch discovery can differ. |
| `scripts/windows/Register-LanAnnouncer.ps1` | Explicitly register the announcer at Windows sign-in and start it. |

## Manual installation

Run these commands from the repository or extracted installation root.
The setup scripts also resolve that root when launched from another directory.

Download the source or clone this repository. Work in its root directory.

1. Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell,
   or `cp .env.example .env` on Mac/Linux).
2. Set `SERVER_ADDRESS` to the Docker host's reserved LAN IPv4 address or DNS name.
   Keep the port out of this value. For access only on the host, leave `localhost`.
   On native Linux Engine set `DOCKER_SOCKET_GID` to the result of
   `stat -c %g /var/run/docker.sock`; Docker Desktop uses 0. Leave
   `FACTORIO_PLATFORM=linux/amd64` so the game and isolated map workers agree.
   On ARM64, configure Docker’s amd64 emulation first; see the setup guide.
3. Pull the published images with `docker compose pull`, then choose **one** of these setup commands:

   ```sh
   # New random world, generated when Factorio first starts:
   docker compose run --rm --no-build setup --new-world
   ```

   ```sh
   # Existing save: first copy your ZIP into an import/ directory in this checkout.
   docker compose run --rm --no-build setup --save /workspace/import/world.zip
   ```

   Setup validates imported ZIP contents and copies the save. It prints a private,
   single-use registration link, valid for 24 hours. Keep it private. Existing
   saves/configuration/accounts are preserved on reruns; importing over existing
   saves is refused. Setup does not start or stop the game.
4. Start the stack:

   ```sh
   docker compose up -d --no-build
   docker compose ps
   ```

5. Open the registration link to create your administrator account. The normal
   panel address is `http://YOUR_SERVER_ADDRESS:8080`. In Factorio choose
   **Multiplayer → Connect to address**, then `YOUR_SERVER_ADDRESS:34197`.

The initial LAN game pauses when empty, autosaves every five minutes, retains ten
autosaves, and saves when the last player leaves. Game account verification is
disabled for LAN usernames; anyone on the allowed network can join the game
unless you set a game password or whitelist. Panel registration remains private
and invitation-only. Add a game password under Settings if needed.

If a setup link expires, generate a replacement without changing the world:

```sh
docker compose run --rm setup --registration-link
```

This invalidates previous setup/recovery invitations and retains registered users.
Do not run setup or start a second stack against another server's data directory.


## Operations and upgrades

Use the panel for saves, backups and world changes. World switches/restores
disconnect players and create a backup first. To stop the stack with time to save:

```sh
docker compose stop
docker compose start
```

Before an upgrade, download a verified full backup and keep a copy on a separate
device. Read the release notes, update the source, then deliberately run
`docker compose up -d --no-build`. This can recreate containers and disconnect players.
Editing source files alone does not update the running app. Do not upgrade the
Factorio image independently of the clients. No automatic game/mod updates occur.

The panel checks public GitHub releases every six hours and notifies administrators
in Settings and the sidebar. Administrators can also use **Check for updates** in
Settings → Updates for a fresh check, limited to once per minute. This checks only
public release information. Settings → Updates lets an administrator review and
install supported panel/controller releases or separately upgrade Factorio to a
chosen newer 2.0.x version, with pre-update backups, persistent progress and recovery.
See [in-panel updates and one-time enablement](UPDATES.md). Preview releases
are included by default for this alpha; stable-only and offline modes are available.

Keep `data/`, `backups/`, `.panel-data/` and `.env` private. Never upload the entire
working directory: those folders contain worlds, credentials, invitations and
server configuration. `.gitignore` excludes them, and the release packaging tool
uses an explicit source allowlist.


## Alpha limits

The map, world-preview and ZIP limits below apply to Factorio. Rust has separate
[platform requirements and streaming archive limits](RUST.md).

- Trusted LAN over HTTP; no built-in TLS or Internet deployment support. The
  controller has Docker socket access, which effectively grants control of the
  Docker host. Treat panel administrator access accordingly.
- Only one stack per checkout. State uses JSON files; multi-controller/replica
  deployments are unsupported. Web restarts expire browser sessions.
- Saved maps are sampled overviews of explored Nauvis, capped at 2,048 chunks,
  80,000 objects and 24 MB. They are not full game graphics.
- Live player positions are off by default. Enabling them requires explicit
  acknowledgement that Lua commands disable achievements for that world; the
  panel creates a verified backup first. Turning tracking off does not undo this.
- Save uploads: 128 MB. Backup ZIP uncompressed total: 512 MB. ZIP64 and encrypted
  ZIPs are unsupported. Backups stored on the same host are not disaster recovery.
- World previews take a few seconds and can delay another management operation
  until the current preview finishes. Version-specific world options target 2.0.77.
- Tests cover access controls and destructive-operation recovery, but this alpha
  has not received an independent security audit.
