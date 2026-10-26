# Authoring an application package

Application-specific runtime, image sources, build checks and optional panel
extensions belong in `panel/applications/<id>/`. Add the ID to the explicit
`registry.json`. Shared code and CI do not enumerate application names.

```text
panel/applications/status-page/
  definition.json
  images.json
  images/
    image.json
    Dockerfile
    server.mjs
    server.test.mjs
    acceptance.mjs
  README.md
```

Status Page is the third production-shaped integration: a real HTTP process with
persistent typed configuration, Docker readiness and shared panel controls. It
has no `index.js`, custom panel JavaScript, presentation file or copied screens.
The HTTP page is application code inside its image, independent of panel UI.
Images are built/tested locally before publication; adding this package does not
publish its image or deploy it on an existing host.

## Existing providers

Select `managed-container-v1` for one required web/service/worker process in one
reviewed amd64 image, with TCP/UDP listeners and one data claim. The image owns
its command and must supply a Docker health check. The provider supplies:

- Normal fleet provisioning, digest and image-label admission, scoped Docker
  access, start/stop/restart, bounded readiness polling and logs.
- Typed JSON configuration at a declared file in the data root. Configuration
  requires a definitively stopped process and a matching revision. These are
  public non-secret values; the application can read them through its scoped group as mode 0640.
- Stopped-data ZIP backups, verification and snapshot cloning into a fresh
  instance with fresh controller credentials. Files are bounded to 4096 and
  64 MiB. Metadata traversal is capped at 8192 entries and 32 directory levels
  before file contents are read. Links and unsafe paths are rejected. This profile does not offer
  in-place restore or automatically stop processes for a backup.
- A private installation marker pinning the definition revision and content hash.
  Changing a definition cannot silently adopt an existing instance.
- Default overview, settings, logs, backups, operations and accounts screens,
  using the existing shared permission and operation system.

The managed-container profile reuses the service lifecycle factory, typed JSON
configuration, managed host compiler and archive/storage providers. Internal
legacy `game` fields and the primary `gamePort` are retained for fleet/updater
compatibility; non-game creation hides player and world controls.

The profile requires a numeric non-root image UID (1–65535) with group 0. Its
scoped data directory is mode 0770; restored data files are mode 0660. This lets
the application write its own data without adding privileges to storage workers.
Private control/state directories remain outside the application's mount.
Applications requiring another ownership model, private secret providers, deployment tasks, multiple
services, database-consistent backups, ingress or TLS need a reviewed profile.
They cannot obtain those capabilities by adding arbitrary definition fields.

Factorio and Rust retain their reviewed managed-game adapters for specialized
protocols, save barriers, world formats, mods and maps. Their IDs, data locations,
image defaults and running instances are preserved.

## Image recipes

`images.json` contains version 1 and an `images` array. Each recipe declares:

- `id`, a package-local identifier; `manifest`, the image metadata file; and
  `dockerfile`, its path **inside the generated context**.
- `files`, an explicit array of package-relative `source` and context-relative
  `target` paths. The builder copies only these regular files to a temporary
  directory and removes it even if the build fails. No checkout, private `.env`,
  game data, dependencies or backup directories are sent implicitly.
- `buildArgs`, mapping argument names to image-metadata fields. Base images
  require an immutable digest. Image tag/repository identity lives in image.json.
- `checks`, source checks with a fixed `node`, `node-test` or `python` runner.
- `acceptance`, package-owned native scripts. Local execution requires an exact
  disposable-engine identity; hosted Actions run on their fresh job engine.

Image metadata uses `format: 1`, `repository`, `tag`, `platform` and `baseImage`,
plus application-specific build values. Packages can declare several images,
including Factorio's bundled and runtime delivery variants.

```sh
node tools/application-images.mjs list
node tools/application-images.mjs check status-page/server
node tools/application-images.mjs build status-page/server
LOBBY_DISPOSABLE_ENGINE_ID=<isolated-engine-id> \
  node tools/application-images.mjs acceptance status-page/server
```

The application-image workflow generates its matrix from the same catalogue.
Adding a fourth package needs no workflow edits. Publication remains an explicit
manual action and refuses existing tags. Tags are never overwritten. Rust's
self-contained dependency set has the new, unpublished `steam-lg.3` recipe;
managed defaults remain pinned to `steam-lg.2` until an explicit future change.
Manual Factorio publication retains migration and backup-recovery acceptance.
Both games bind native acceptance to their recipe's image reference and immutable
local build ID, including Rust's fresh installation and mod checks.

## Historical source bundles

The repository owns image sources inside each package. Release generation still
emits Factorio image sources at `factorio-image/` and Rust image sources at
`panel/games/rust/image/` for historical updaters. Source lookup handles the
canonical package, previous `images/` organization and extracted release layout.
The Factorio root tool is a compatibility entry point into its package.

Complete source archives include the generic image CLI. Historical update ZIPs
retain the old admitted root files and extensions. Frozen v0.2.0 and v0.3.3
validators remain part of the package regression suite. Image source directories
are excluded from management image contexts; the runtime carries providers and
package declarations, not Docker recipes or application binaries.

See the [verification record](verification/application-packages.md) for source,
updater, browser and disposable-container evidence and remaining boundaries.
