# Lobby Goblin Factorio image

The current source builds
`ghcr.io/jkenneydaniel/factorio-server:2.0.77-fc.3`. This advances the wrapper
without changing Factorio 2.0.77. Revision 3 includes the first-world retry and
ownership-scan fixes and current Lobby Goblin labels. Revision 2 is already
published, so it is never overwritten. New installations and automatic v0.3.4
migration use revision 3 after publication.
It is built independently from digest-pinned Debian and the official Wube
headless download, verified against the SHA-256 in `image.json`. The image does
not use or copy from `factoriotools/factorio`. Publishing is a separate step;
adding this source does not make the tag available in GHCR.

Only `linux/amd64` (x86-64) is built for this release. ARM64 hosts may use Docker's
amd64 emulation where available; there is no native ARM image or bundled emulator.
Factorio 2.1 has native Linux ARM support, but changing the game branch is outside
this same-version compatibility migration.

## Compatibility contract

- Persist saves, configuration, mods, scenarios and script output under `/factorio`.
- Preserve user/group 845, `/opt/factorio/bin/x64/factorio`, the `rcon '<command>'`
  CLI, UDP 34197, internal RCON 27015 and `/docker-entrypoint.sh`.
- Keep existing settings, admin/ban/whitelists, RCON password, server identity,
  saves, mod files, mod settings and mod selections intact. Only missing files
  receive defaults. The runtime uses the chosen UID/GID and execs the game as
  PID 1 so it receives Docker's graceful shutdown signal.
- Support the panel's `LOAD_LATEST_SAVE`, `GENERATE_NEW_SAVE`, `SAVE_NAME`, data
  paths, `PORT`, `RCON_PORT`, `PUID`, `PGID`, `PRESET`, `BIND`, console logging and whitelist startup options.
  DLC defaults apply only when creating a missing mod list. Existing selections
  are never rewritten. Automatic mod downloads are unsupported and startup
  refuses `UPDATE_MODS_ON_START=true`; the standard stack already sets it false.
- A genuinely fresh installation can generate its first world. An existing
  server identity without saves is refused unless generation is explicitly
  requested. Existing saves are never overwritten by generation.

The first-party startup and RCON programs are MIT licensed. Factorio remains
proprietary; its license is not changed by the container wrapper.

The canonical build source is in `panel/applications/factorio/images/`. The complete `.source.zip`
places it at the historical `factorio-image/` path; the regular update ZIP retains
its older allowlist. See [repository and release layout](../../../../docs/REPOSITORY.md).

## Build and verify

For development, use Node 24 and Python 3 for the isolated source tests:

```sh
node --test panel/test/game-images.test.js panel/test/update-install.test.js panel/applications/factorio/images/test-build.mjs
python3 -B panel/applications/factorio/images/test_runtime.py
node tools/factorio-image.mjs describe
```

The following commands explicitly use Docker to build/test **a new image and
disposable data**, without targeting any installed stack:

```sh
node tools/factorio-image.mjs build
node tools/factorio-image.mjs test
```

The container acceptance test runs the panel's read-only image preflight
against the owned image, selecting amd64 metadata as needed. Published images use
verified repository digest references; a freshly built image without a registry
digest in a classic Docker store is tested by its immutable local image ID. The
panel still requires a repository digest for every installed image.
It uses Factorio Tools solely as legacy test input: it creates a world in a unique
disposable volume, loads it with our independently built image, checks RCON and
settings/mod/password checksums, saves, stops gracefully, then reloads the save
with the old binary. It also verifies direct world creation and a 128 × 128 PNG
map preview. Its Lua check acknowledges the achievement prompt only inside the
disposable save. It removes only its test containers and volume, publishes no
ports and disables container networking. It never mounts `./data`, invokes
Compose or targets the running server.
CI runs these checks before publication; local mocked/unit tests do not establish
container acceptance.

Local build and container acceptance passed on October 16, 2026, using OrbStack
on an ARM Mac with amd64 compatibility support. See `docs/VERIFICATION.md` for
the exact image identity and scope. This does not establish native ARM support,
an independent x86 Linux-host test or GHCR publication.

Revision 2 passed the same isolated build and container acceptance checks on
October 17, 2026. It retains Factorio 2.0.77 and the compatibility contract above;
these checks did not publish or install the new revision.

## Publish deliberately

Run the **Lobby Goblin game images** GitHub Actions workflow with `publish`
enabled after reviewing the source. Regular pushes and pull requests build/test
only. Publication uses the repository's GitHub token, refuses an existing tag
and pushes the exact image that passed its test. Increment `revision` and the
matching Dockerfile default for packaging changes; update `version`, the official
archive checksum and Dockerfile defaults for game changes. Do not reuse a tag.

The GHCR package must be public before ordinary installations can pull it:
the panel does not forward personal registry credentials. First publication may
need repository package permissions/visibility configured in GitHub.

Publishing does not deploy or migrate servers. Installing the v0.3.4 controller
subsequently performs the one-time same-version migration described in
[image migration](../../../../docs/IMAGE_MIGRATION.md). Later game-version changes still
use Settings → Updates with a verified backup and reviewed image selection.
Keep the old container/image and pre-change backup until acceptance is complete.
