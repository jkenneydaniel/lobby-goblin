# Lobby Goblin

**Your servers. One helpful goblin.** A self-hosted game server control panel with
shared accounts, permissions, jobs and backups, plus dedicated game modules.
This is an early alpha for trusted administrators. The repository is
[`jkenneydaniel/lobby-goblin`](https://github.com/jkenneydaniel/lobby-goblin).

| Game | Controls |
| --- | --- |
| Factorio | Worlds and saves, map previews, players, settings, backups and recovery, live mod library, guided setup, reviewed updates |
| Rust | Status, lifecycle, players, logs, settings, Carbon / Oxide / uMod, live plugin library, complete backups and verification |

## Install

For a new multi-game host manager, start with the [installation guide](docs/INSTALLATION.md).
Run the installer on the computer that will host the servers:

```powershell
./Install.ps1
```

```sh
sh ./Install.sh
```

On macOS, you can also open `Install.command`. The guide covers private local
access, experimental hosted HTTPS using a public IP or hostname with automatic
Let’s Encrypt renewal, Docker prerequisites and administrator
registration in your browser. The installer creates a separate installation;
existing servers, accounts and worlds are not adopted. The host manager requires
Linux x86-64 containers. See the guide for memory and host requirements.

To run games on other machines, use **Hosts → Add host**. Choose automatic
installation over SSH or manually install the agent and enter its pairing code.
The panel can run locally or remotely; daily management and reviewed agent
updates use the persistent, pairing-secured agent connection on a configurable
dedicated port (24443 by default). See [remote game hosts](docs/REMOTE_HOSTS.md).

Use **Updates → Update management services** to review and install coordinated
updates for the panel, broker and controllers while game containers keep running.
Windows, macOS and Linux hosts use the same coordinated updater. Older versions
need one host-side upgrade to enable the portable coordinator. See [management updates and recovery](docs/MANAGEMENT_UPDATES.md).

For an existing installation or a dedicated single-game setup:

- [Standalone Factorio](docs/SETUP.md): `sh scripts/standalone/Setup.sh` or
  `./scripts/standalone/Setup.ps1`. ARM64 hosts require amd64 game emulation.
- [Standalone Rust](docs/RUST.md): prepare a new, separate installation.
- [Advanced host-manager launcher](docs/FLEET.md): scripts under `scripts/fleet/`.

Commands in this checkout use the organized source paths. Downloadable release
bundles retain the historical installed paths expected by older updaters. See
[repository and release layout](docs/REPOSITORY.md) before moving existing files.

## Existing installations and updates

Keep your current installation directory, environment, accounts, worlds and backups.
Editing or downloading source does not update a running installation. Read the
[update guide](docs/UPDATES.md) before deliberately installing a release.

Installing a controller with the v0.3.4 migration can replace supported historical
game images after a verified backup and clean stop. That one-time migration can
disconnect players; read [image migration and recovery](docs/IMAGE_MIGRATION.md).
Later game-version updates require their own reviewed operation. Publishing an
image alone does not deploy it.

Rust mod management requires the mod-capable image and matching controller mounts;
existing servers are not restarted merely to enable mods. See
[Rust mods and recovery](docs/RUST.md#mods-and-plugins).

## Documentation

| Topic | Guide |
| --- | --- |
| New installation and administrator onboarding | [Installation](docs/INSTALLATION.md) |
| Standalone Factorio and platform requirements | [Setup](docs/SETUP.md) |
| Rust setup, mods and recovery | [Rust](docs/RUST.md) |
| Browse, install and update mods or plugins | [Live mod library](docs/MOD_LIBRARY.md) |
| Multiple servers and shared snapshots | [Host manager](docs/FLEET.md) |
| Server volumes, retained data and recovery | [Server storage](docs/RETAINED_STORAGE.md) |
| SSH setup, pairing and agent updates | [Remote game hosts](docs/REMOTE_HOSTS.md) |
| Source organization and installed compatibility | [Repository layout](docs/REPOSITORY.md) |
| Shared runtime and game-module boundaries | [Architecture](docs/ARCHITECTURE.md) |
| Local tests, builds and release preparation | [Development](docs/DEVELOPMENT.md) |
| Game image sources and compatibility contracts | [Factorio](panel/applications/factorio/images/README.md), [Rust](panel/applications/rust/images/README.md) |
| Add a small application | [Package guide and copyable template](docs/ADDING_AN_APPLICATION.md) |
| Recorded validation and remaining limits | [Verification](docs/VERIFICATION.md), [installer acceptance](docs/INSTALLER_ACCEPTANCE.md) |
| Features, security and release history | [Panel](panel/README.md), [security](SECURITY.md), [changelog](CHANGELOG.md) |

The panel/controller runtime and the two game images have separate build and
publication workflows within this repository. Game image versions are independent
of the panel version. The source definitions and configured workflows do not
establish publication, deployment or runtime acceptance; consult the verification
records for the scope of completed checks.

## License

Original project code is [MIT licensed](LICENSE). Factorio, Rust and external
components have separate terms; see [third-party notices](THIRD_PARTY_NOTICES.md).
This is an unofficial project, unaffiliated with Wube or Facepunch Studios.
