# Updates through the panel

Broker-enabled hosts use the explicit [management update command](MANAGEMENT_UPDATES.md)
to update the broker and management services together. The legacy panel updater
is refused on those hosts. The operator workflow preserves application containers
and data, with pre-activation rollback and committed forward recovery. Unfinished
updates and cleanup block another update or an installation start.

For legacy standalone installations, the existing panel update path below remains
available. Its interrupted updates require inspection and explicit acknowledgement
before another update. Required world recovery cannot be acknowledged away.

## Lobby Goblin naming compatibility

The canonical repository is `jkenneydaniel/lobby-goblin`. Current code maps the
historical owned repository setting to that name. No checkout, `.env`, account,
container, world or backup path needs renaming. New installs pull the versioned shared runtime from
`ghcr.io/jkenneydaniel/lobby-goblin`; explicit installed image values remain valid.

Release tooling emits the Lobby Goblin packages below plus historical archive-name
aliases with matching ZIP roots. Already installed 0.2.x workers require those
aliases. Current workers accept either name; the payload and state contract are
the same. Published Factorio image tags and the `factory` source selection remain
stable, and both historical and current compatibility labels are accepted.
Current images use Lobby Goblin labels; older labels are recognized when inspecting historical images.

Panels released before this rename reject HTTP redirects from GitHub's release
API. After a remote repository rename, those older panels need their
`RELEASE_REPOSITORY` setting changed to `jkenneydaniel/lobby-goblin` at the next
**deliberate panel update**, or a manual update to this code. Their game/world
operations continue to work. Source changes here do not modify an installation.


Settings → Updates supports administrator-triggered installation for two separate
items: Lobby Goblin (web panel and matching controller) and the Factorio game
container. Automatic checks notify; an administrator reviews and confirms installation.
Installing v0.3.4 also triggers the documented one-time game image migration
after the panel update completes. See [image migration](IMAGE_MIGRATION.md). This does not update Docker Desktop, Docker Engine, the
host OS or mods.

## Installed paths and repository paths

The procedures below run inside an installed release directory. Release bundles
retain root `Setup.*`, `Fleet.*`, `fleet.compose.yaml` and the historical image
source locations so older updaters can validate them. In a Git checkout, helper
scripts live under `scripts/` and image sources under `images/`; see
[the repository and release layout](REPOSITORY.md). Do not move installed state
or reset its update baseline as part of source reorganization.

## Enable once on an existing installation

This feature must first be installed using the normal host upgrade procedure;
an older notification-only panel cannot install its own missing updater.
Preserve `.env`, `data/`, `backups/` and `.panel-data/`. Run the updated host setup
once without starting the stack (`sh Setup.sh --new-world` or
`.\Setup.ps1 -NewWorld`). On an existing installation it preserves worlds/accounts,
creates the private update-state directory and records hashes of installation
source files. This baseline is not silently reset on later setup runs.

When you deliberately deploy the new panel/controller, the image also includes
Docker's client, Compose and Buildx for a detached installation worker. No extra
host language runtime is needed. That first deployment is separate from preparing
this source and has not been performed on the running server.

The initial implementation supports the standard single `compose.yaml` local
installation layout and bind mounts, on the host platforms in SETUP.md. Additional
Compose overrides, custom container identities inconsistent with Compose labels,
unrecognized game image repositories and unsupported state migrations require a reviewed
host upgrade. Existing customized ports, address and configured names are retained.

## Install a panel release

### Recover an older updater with missing CA certificates

Some v0.2.0–v0.2.3 images lack the system certificate bundle. Their update build
can fail with `x509: certificate signed by unknown authority`, even when the host
can build successfully. Those installations need one host upgrade to v0.2.4 or
later; the new setup checks cannot repair an already-running older worker.

Back up the world and private installation state. Verify the new release checksum,
then extract its complete `.source.zip` over the reviewed public source files,
preserving `.env`, `data/`, `backups/` and `.panel-data/`. Set only `PANEL_IMAGE` in
the existing `.env` to `local/lobby-goblin:0.2.4-alpha`; retain the game image,
addresses and ports. From that installation directory run:

```sh
docker compose build panel-controller panel
docker compose run --rm --no-deps setup
docker compose up -d --no-deps --no-build --pull never --wait panel-controller panel
```

This replaces only the panel services. Once they are healthy, deliberately record
the reviewed new source baseline below. This is a manual-upgrade action: it accepts
the current public source as installed, so first reconcile any local source edits.
Ordinary setup reruns never reset that baseline automatically.

```sh
docker compose run --rm --no-deps --entrypoint node setup --input-type=module -e 'import {sourceSnapshot} from "/app/update-source.js"; import {writeJSON} from "/app/common.js"; import fs from "node:fs/promises"; const file="/workspace/.panel-data/updates/baseline.json"; await writeJSON(file,{format:1,files:await sourceSnapshot("/workspace")}); await fs.chown(file,845,845);'
```

Future releases can then use the panel installer. The registry certificate bundle
must also be present in the release being installed, so keep the fix in later
images. Do not disable HTTPS verification to work around this error.

### Normal panel installation

1. Open Settings → Updates and read the linked release notes.
2. Choose Review panel update. The server checks the eligible release, package
   availability, current container identities and a review expiry of 15 minutes.
3. Choose Install update. A world/config/mod backup is saved and archive-verified.
   The detached worker records recovery copies of source, environment, panel
   account/controller state and secrets in `.panel-data/updates/<job-id>/`.
4. The worker downloads the ZIP, checksum and installer metadata, validates ZIP
   contents/paths and the supported state contract. New releases declare the
   published runtime image: the worker pulls it, validates its version/source/runtime
   labels and native architecture, and pins its repository digest. Historical
   releases without this metadata retain the compatible local build path.
   Source files with local edits block installation. The baseline is checked again
   after image preparation before source promotion.
5. The installation worker replaces the panel and controller. In v0.3.4, the new
   controller subsequently migrates supported older game images after this update
   completes; that separate migration disconnects players on running servers.
   Updated services must report healthy; otherwise the previous source/config and
   supported panel state are recovered and the previous image is restarted.
6. Sign in again after panel replacement and review Installation history. Progress
   survives panel replacement and is visible to other administrators. A temporary
   browser disconnect is not treated as success.

The source package and selected image stay consistent, so later host startup
uses the installed release image. Explicit development builds use the reconciled
source instead of accidentally rebuilding older source over a new release.
Mount/port changes and new services are refused by this installer. Checksum
verification detects transfer corruption; it is not an independent signature or
protection against a compromised trusted release publisher. Do not install an
untrusted release merely because its checksum matches.

## Upgrade Factorio separately

Choose an exact `2.0.x` Factorio version and its published Lobby Goblin image
revision. Only `ghcr.io/jkenneydaniel/factorio-server:<version>-fc.<revision>` is
supported. The v0.3.4 startup migration handles recognized older images first;
Factorio Tools is no longer offered as an image choice.

Choose a newer game version to upgrade, or keep the same version and choose a
newer wrapper revision. Game/revision downgrades, floating tags and arbitrary
repositories are refused. Matching clients and compatible mods are still
required. Mods and DLC selections are not automatically changed. Only `2.0.x`
and `linux/amd64` are supported; ARM retains Docker's amd64 emulation policy.

Our image is built directly from Debian and the official Factorio download,
without using Factorio Tools as its base. Its build and deliberate publication
procedure is in [factorio-image/README.md](../panel/applications/factorio/images/README.md). The tag
must be published and publicly pullable before it can be installed.

Review shows the exact target image and explains a same-version change. After
confirmation, installation saves and verifies a pre-change archive, pulls the
selected image, verifies its declared version, paths, permissions, entrypoint,
ports and compatibility revision, then runs a disposable version/tool probe with
no host data mounts or network. The verified image is pinned by repository digest.
Only the Factorio image changes; existing environment, startup options, mounts,
ports, names and world/config/mod data are preserved. It then checks the reported
version through RCON. Players disconnect during replacement. A stopped game is
started by a confirmed image change, as described in the review.

If download/preflight fails, the running game is left unchanged. If replacement
or readiness fails, the game is stopped and the previous image is prepared in a
stopped container. Upgraded saves remain intact. **No world backup is silently
restored.** Restore the recorded pre-update archive explicitly from Backups; other
server jobs and further upgrades are blocked until that restore succeeds. Restore
keeps a copy of the failed state through the existing backup/restore workflow.
Saves written by a newer game may not load in an older binary.

## Release publication contract

The source packager and release workflow now emit/upload:

- `lobby-goblin-<version>.zip`
- `lobby-goblin-<version>.sha256`
- `lobby-goblin-<version>.manifest.txt`
- `lobby-goblin-<version>.update.json`

Releases also provide `.source.zip`, `.source.sha256`, `.source.manifest.txt`
and `.source.update.json` bundles containing the independent image build files.
New installers prefer this complete bundle. The original ZIP omits those new
paths so existing 0.2.x workers can install the panel without rejecting unknown
source files. Both bundles use the same release root and tested panel source.
For a complete fresh source checkout, use `.source.zip` or Git. Source-bundle
metadata adds `bundle: "source"`; the older update assets retain their contract.

Installer metadata declares `format: 1`, the exact version, `updater: 1`,
`stateVersion: 1` and `rollbackSafe: true`. A release requiring persistent-state
migration must change that contract and provide an appropriate installer; do not
retain the rollback-safe flag by default when changing persistence semantics.
Previously published releases without the installer assets remain viewable but
cannot be installed through this flow. v0.2.0-alpha is the first release with
these installer assets. Installations on v0.1.0-alpha need the one-time host
upgrade described above before future in-panel updates are available.

## Checks, permissions and recovery

The updater image must include a system CA certificate bundle for Docker and
Buildx. Node's built-in certificate roots do not provide the Go Docker client's
OS trust store. The image copies the bundle from the same Docker CLI build stage;
HTTPS verification remains enabled. A cached base image can hide this omission,
so CI also makes a fresh registry manifest request from the restricted worker
environment before testing a real build through the Docker socket.

Failed Docker steps retain an 8 KiB diagnostic tail with the operation, exit code,
signal, timeout and output-limit state in the private update job JSON's `failure`
field and in the worker logs. Common credential forms are redacted. Successful
machine-readable Docker output is not logged. Preserve these private records when
investigating an interrupted update.

Automatic public GitHub checks run at startup and every six hours. Administrators
see installed/available versions, channel, last check and release notes. Use
**Check for updates** to bypass the automatic cache without installing anything;
repeated checks within one minute reuse the latest result. The review action
appears when a newer eligible release is detected. Disabled checks stay disabled.
Checks use
an eight-second timeout, bounded responses, ETags and semantic version ordering;
they exclude drafts and never offer a downgrade. They consider at most the 100
most recent releases. Offline/rate-limit errors mean unavailable, not up to date.

`.env` options:

```dotenv
RELEASE_CHECKS=true
RELEASE_REPOSITORY=jkenneydaniel/lobby-goblin
RELEASE_CHANNEL=preview
```

`stable` excludes prereleases; `preview` includes alpha/beta/RC versions. Disabling
checks also prevents panel-release review from fetching releases. A manually
requested Factorio upgrade still downloads its selected official image. Apply
environment changes deliberately; editing `.env` does not alter running services.
No saves, accounts, logs or credentials are sent to GitHub.

Review/install/history endpoints require administrator access. Mutations require
CSRF and same-origin verification. Updates serialize against world operations,
map previews and scheduled backups. Account changes are paused during updates.
The public web service has no Docker socket. The controller starts a tightly
specified, root update worker from its own installed image, with Docker access
and the installation bind mount. Treat this worker and release publisher as
trusted host-management code, as with the existing Docker-enabled controller.

The worker has no automatic restart after host power loss. Interrupted workers
are reported as failed and retain recovery details; a host/source recovery may be
needed. If automatic recovery itself fails, history explicitly requests host
intervention. Do not delete recovery directories or old images until you have
confirmed the update. Recovery copies contain private account/secrets state and
must stay private. Off-host backups and a successful isolated game restore are
separate from archive verification.

Implementation has been tested with temporary source/data fixtures and simulated
Docker operations. No live container lifecycle update, independent Linux/Windows
host, or ARM game-emulation acceptance was run for this work. See VERIFICATION.md.

References: [Compose recreation](https://docs.docker.com/reference/cli/docker/compose/up/),
[GitHub releases](https://docs.github.com/en/rest/releases/releases).

## Runtime image publication and worker cleanup (v0.3.5)

The **Lobby Goblin panel and controller image** workflow tests the shared runtime,
builds and smoke-tests linux/amd64 and linux/arm64, and publishes their versioned
GHCR manifest only when deliberately requested or called by release automation.
The same image supplies the web panel, controller, setup and update worker.
Existing published tags cannot be overwritten. A release can reuse an existing
runtime only when its recorded source revision has the identical complete
`panel/` Git tree, allowing separate game-image fixes without changing runtime
bytes. Changed runtime source requires a new version. Make the GHCR package public
before distributing an installer that depends on it. A publication does not
replace any running installation. Source-based builds remain available to developers.

New update workers use Docker's automatic container removal. Their durable jobs,
recovery copies and logs remain under the installation's update storage. A scoped
sweeper retires verified stopped historical successful workers; failed/interrupted
workers are retained for 24 hours and their last bounded, redacted log lines are
saved in the job record before removal. Cleanup verifies job/root/environment,
labels, data binding and stopped state immediately before a non-forced delete.
It never deletes Docker volumes or removes a running server. Unknown workers
without sufficient ownership evidence are kept for manual inspection.

## Fleet update discovery

The fleet navigation includes **Updates**, with the installed panel release,
release channel, GitHub release notes, manual refresh and host-update guidance.
Release checks are enabled by default for the fleet web panel; setting
`RELEASE_CHECKS=false` explicitly still disables them. Management installation
continues to use the [local operator workflow](MANAGEMENT_UPDATES.md), which
updates the panel, broker and controllers together. The browser cannot invoke that
workflow or access its private records. Agent alignment remains under **Hosts**.

Application discovery is read-only and cached for 15 minutes, including failures.
Factorio's official latest-release API identifies stable/experimental releases.
The Lobby Goblin registry supplies the published compatible image versions and
revisions. The standalone Factorio update form selects from those images instead
of accepting a typed version/revision; the existing review, backup and image
validation workflow still controls installation. Upstream releases in an
unsupported line (currently versions outside 2.0.x) are shown without presenting
them as installable. A registry failure leaves no selectable installation target.

For managed servers the fleet catalogue supports discovery and links to the
server's existing controls, but game-image installation remains unsupported.
Management updates do not upgrade game binaries.

Rust's public Steam news API supplies recent official announcements, linked from
the fleet Updates screen. News is not evidence of installed or available server
builds. The Steam UpToDateCheck response for Rust did not supply a usable build
identifier during verification. Rust build detection, branch selection and
installation still require a separate SteamCMD-backed workflow: compare the
installed `appmanifest_258550.acf` build ID with Steam's selected branch metadata,
then review a backup, downtime, framework compatibility and build verification
before changing the installation. Historical build pinning is not implied by a
Steam news item or an arbitrary version number.

Software delivery now has an explicit per-service declaration; see
[software delivery policy](APPLICATION_DEFINITIONS.md#software-delivery-is-separate-from-image-admission).
Image mode keeps the image-based Factorio workflow. Runtime mode discovers
software releases independently of image tags and identifies updates as software
changes. The initial version resolver preserves a checked installed receipt and
never resolves latest again for an existing installation. New Factorio servers
can explicitly choose the independent runtime image and use the software picker
for verified upgrades and paired recovery. Existing bundled servers keep their
image workflow. See [Factorio runtime software](FACTORIO_RUNTIME.md).
