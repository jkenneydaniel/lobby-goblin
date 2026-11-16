# Repository and release layout

Lobby Goblin stays in one repository. The shared runtime and its game-image
compatibility checks can be reviewed together, while each image keeps its own
version and publication workflow. Source organization does not rename installed
directories, reset update baselines, change configuration or deploy services.

## Git checkout

```text
Install.sh / Install.ps1 / Install.command   Primary new-installation entrypoints
panel/                                     Web, controllers, core and game modules
panel/applications/<id>/                    Definitions, adapters, image sources and tests
scripts/install/                           Explicit Docker installation helper
scripts/standalone/                        Existing Factorio setup and start tools
scripts/fleet/                             Advanced host-manager launchers
scripts/windows/                           Optional LAN, firewall and autostart tools
deploy/fleet/                              Fleet Compose and environment examples
tools/                                     Release, image acceptance, performance tools
docs/                                      Guides, contracts and recorded verification
docs/verification/                         Historical design verification
.github/workflows/                         CI and deliberate publication workflows
```

`compose.yaml` and `.env.example` stay at the root because existing standalone
setup, migration and update logic use that installation layout. Rust's separate
Compose template stays at `panel/applications/rust/compose.yaml`: its preparation code
and published runtime consume that file. Moving it outside `panel/` would change
the runtime build contract without simplifying the user installation.

`dist/` contains generated release artifacts and `output/` contains local captures
and diagnostics. Both remain ignored. They are not alternate source trees, and
reorganization does not delete their existing contents. Never store private
installation state, saves or credentials in source directories.

## Downloadable releases and older updaters

Release source paths are an installed compatibility contract. Older updaters
validate every ZIP entry against their own fixed allowlist before executing any
new code. Merely teaching a new updater about source package paths or `scripts/` cannot make
an already-installed updater accept those directories.

`panel/source-layout.js` defines the source-to-installation mapping, used by
`tools/release.mjs` and source tooling:

| Canonical checkout source | Complete release bundle path |
| --- | --- |
| `panel/applications/factorio/images/` | `factorio-image/` |
| `panel/applications/rust/images/` | `panel/games/rust/image/` |
| `scripts/standalone/*` | Historical root `Setup.*` / `Start-Server.*` |
| `scripts/fleet/*` | Root `Fleet.*` |
| `scripts/windows/*` | Historical root Windows helper names |
| `scripts/install/Install-Docker.sh` | Root `Install-Docker.sh` |
| `deploy/fleet/compose.yaml` | Root `fleet.compose.yaml` |
| `deploy/fleet/.env.example` | Root `.env.fleet.example` |

The normal update ZIP preserves the original smaller allowlist. Packaging adds
the Factorio image guide at `docs/FACTORIO_IMAGE.md` in that ZIP and redirects
its documentation links, since the image-source directory is excluded. The complete
`.source.zip` includes installer, fleet and image-build sources in their historical
locations. Both retain metadata/state contract versions and historical archive-name
aliases. Documentation links, guide commands and workflow paths are rebased for
the extracted layout; this document intentionally describes both layouts.

Source tools resolve either layout. Existing installations keep their original
Compose project, mounts, environment, accounts, backup formats and update paths.
Do not manually move installed state to match the checkout tree. A Git checkout
with local source edits should continue to fail the updater's baseline check.

## Installed compatibility

Keep the existing upgrade paths while installed versions and selected storage
formats remain unknown. GitHub release downloads cannot establish whether an
archive was installed, upgraded, or retired.

| Existing installation | Compatibility to preserve |
| --- | --- |
| Legacy standalone updater | The frozen v0.2.0-alpha and v0.3.3-alpha validators test the historical update ZIP. Keep its asset names, archive roots, allowlist and state-version metadata. This verifies archive acceptance. Full upgrade behavior also depends on the installed configuration and game state. |
| Pre-v0.3.4 game images or interrupted migration | Keep image recognition, the [backup-protected migration path](IMAGE_MIGRATION.md), and recovery for retained journals. Age alone cannot identify a completed migration. |
| Legacy fleet and paired agents | Keep the [host-side upgrade](MANAGEMENT_UPDATES.md), existing transport and [interrupted agent recovery](ISOLATION.md#existing-installations-and-updates). v0.3.14-alpha needs the host-side bridge for the portable updater introduced in v0.3.15-alpha. Later versions can still run the legacy layout. |
| Management documents | Keep [JSON and selected SQLite stores](STORAGE.md). Selection is per accounts, controller or host root. An active `panel-storage.json` marker selects SQLite. Retained JSON may be stale. The existing storage status command can report the selected backend from an operator-provided management copy. |

A future retirement needs a supported upgrade floor and a tested route from
affected versions, including interrupted operations. For a selected SQLite
store, qualify a transition from its current records before removing the reader.

## Ownership and workflows

- `panel/core/`, `panel/fleet/` and `panel/applications/` own application and controller
  behavior. Image bootstraps, tests and build manifests belong in each application package.
- `.github/workflows/game-images.yml` discovers registered package images and supports
  deliberate image publication. `.github/workflows/panel-image.yml` owns the
  shared panel/controller runtime; `release.yml` owns downloadable release assets.
- The Rust image owns its dependency lockfile and reuses its package WebRCON transport.
  The builder sends only the required public files in a temporary build context.
- Publishing images or release artifacts is separate from changing a running
  installation. Refactoring and fixture checks must not access live game storage.

For commands and validation boundaries see [development](DEVELOPMENT.md),
[updates](UPDATES.md), [Factorio image](../panel/applications/factorio/images/README.md) and
[Rust image](../panel/applications/rust/images/README.md).
