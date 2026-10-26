# Factorio runtime software

Factorio supports two installation modes. Existing servers and the default
standalone Compose configuration keep the bundled `2.0.x-fc.N` images. A new
managed server can explicitly choose **Install latest stable once, then select
versions independently**. That selects the separate
`ghcr.io/jkenneydaniel/factorio-server:runtime-fc.1` wrapper image. Its revision
describes the wrapper, not a Factorio release. The host still requires a published,
compatible image and immutable registry digest before provisioning it.

The runtime uses [Wube's free Linux headless distribution](https://factorio.com/download),
which includes Space Age content. It does not require Steam credentials or
SteamCMD. Runtime upgrades do not change the image. Rust keeps its separate
SteamCMD delivery policy and its existing update limitations.

## Installation and restart

The first empty installation resolves the stable channel once. An exact version
can be selected through `FACTORIO_VERSION` for an explicitly prepared standalone
runtime. The entrypoint downloads an exact release, checks its official SHA-256,
rejects unsafe archive paths and links, checks the binary's reported version,
records the complete file inventory, and publishes an installed receipt atomically.
Software lives in `/factorio/runtime/releases/<version>-<archive-sha256>`;
`/factorio/runtime/installed.json` selects the active release. Ordinary restarts
verify and reuse it without querying the release service or requiring network
access. Container replacement preserves the application volume and its release.

Existing saves or an established server identity without a receipt are refused.
The runtime never guesses which version should open an existing world. An
explicitly prepared migration or clone needs `runtime/bootstrap.json`, containing
`version: 1`, `provider: "factorio-headless"`, `softwareVersion` and `sha256` from
the matching release. This is an operator migration, not an automatic conversion
of existing bundled installations. Do not change an existing installation's image
or volume merely to try the new mode.

## Version changes and recovery

Open the server's **Settings → Updates**. The picker shows Wube's stable and
experimental releases and links their change history. Confirming a change starts
an operation with the `images.change` permission. The controller records the
previous full receipt, stops Factorio cleanly, creates and verifies a complete
backup, writes an exact version/checksum request, and starts the runtime installer.
The game must report the requested version over RCON. A previously stopped server
returns to the stopped state after verification.

The installer stages and verifies software before activating its receipt. Previous
release directories are retained. A failed or interrupted update requires review;
it is never replayed by controller startup. Further mutations are blocked apart
from stopping the server or explicitly recovering the software update. Review an
interrupted operation in Operations before using **Recover software update**.
Recovery restores the recorded backup and the old receipt together, then starts
the old release only if the server had previously been running. Recovery keeps the
displaced data in the backup library. It does not select older software against
a world saved by a newer release. The recorded backup is protected from retention.

Backups and published snapshots record the exact software version and archive
hash. Clones install that version, even when stable has advanced, and receive new
credentials. A missing upstream archive or failed checksum leaves provisioning
stopped with its data retained. General backup restore refuses a mismatched
software release rather than silently converting or downgrading the world.

## Preview and world helpers

World generation, terrain previews, copied-world settings export and saved-map
export use the installed release. The controller verifies software files against
the receipt and copies them into a private helper workspace. A read-only overlay
mount exposes that copy at `/opt/factorio`; the helper's writable mount contains
only private scratch data and copies of its inputs. Helpers have no network and
receive no mount of server data, controller records or credentials. The broker
admits only an overlay inside that same helper workspace. Preview and settings
caches include the exact software identity, so changing versions cannot reuse
results from the previous binary.

## Local build and acceptance

From a source checkout or compatible extracted source package:

```sh
python3 -B panel/applications/factorio/images/test_runtime.py
python3 -B panel/applications/factorio/images/test_runtime_install.py
node --test panel/test/factorio-runtime.test.js
node tools/factorio-image.mjs runtime-build
node tools/factorio-image.mjs runtime-test
```

Extracted releases retain the historical `factorio-image/` source path in place
of `panel/applications/factorio/images/`. The build tool resolves either layout. The runtime test
creates uniquely named volumes and containers, publishes no ports, uses no host
bind mounts, and removes its test resources. It checks first installation,
offline recreation, an actual preview, a real stable upgrade, a failed checksum,
and offline recovery of the earlier release with its matching world. The image
workflow runs these checks before a deliberately requested publication. Building
or publishing an image does not deploy or modify an installation.
