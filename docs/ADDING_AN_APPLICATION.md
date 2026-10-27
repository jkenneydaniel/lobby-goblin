# Add a small application

Use the copyable [application template](templates/application/README.md) for one
image-owned process with JSON settings and bounded filesystem backups. It uses
the existing `managed-container-v1` provider: the panel generates Overview,
Settings, Backups, Activity and access controls. No controller, browser adapter,
provider implementation or custom panel page is needed.

The template is an unregistered example, not an installed application. It includes
its definition, image recipe, HTTP process, source tests and native smoke test.
[Status Page](../panel/applications/status-page/definition.json) is the registered
working example and includes full provisioning/backup/clone acceptance.

## Copy and customize

From the repository root, in a development checkout:

```sh
cp -R docs/templates/application panel/applications/example-app
```

Keep `example-app` initially, or rename its directory and replace that identity
in `definition.json`, `images/image.json` and `images/Dockerfile`. Change the
display name, settings and process to suit the application. When renaming, also
change `EXAMPLE_APP_CONTAINER` in the controller environment bindings to the
uppercase ID with hyphens replaced by underscores, followed by `_CONTAINER`. Set your own registry
repository consistently in the definition's default image/reference pattern and
image metadata. Update the image labels to match the definition, keep revision
labels/tag captures consistent, and pin a reviewed base-image digest.

Add the package ID once to `panel/applications/registry.json`. Do not add an
`index.js` or `presentation.json` for this profile. Application image sources and
checks stay under its own directory. The `images.json` file explicitly lists the
files allowed into the image build context; add any new image source there.

## Check before publishing

With the repository's Node 24+ development dependencies installed:

```sh
node tools/application-images.mjs list
node tools/application-images.mjs check example-app/server
npm --prefix panel test
npm --prefix panel run quality
node --test panel/test/module-release.test.js
```

The image check and ordinary tests use source/temporary fixtures; they do not
build Docker images or start game servers. The module-release test verifies source
packaging and historical updater compatibility without publishing a release.
CI discovers the registered recipe automatically.

Build and native acceptance are separate, explicit operations **only on a new,
empty disposable engine**. Never point these at a running application host:

```sh
node tools/application-images.mjs build example-app/server
node tools/application-images.mjs acceptance example-app/server
```

Outside GitHub Actions the native example requires `LOBBY_DISPOSABLE_ENGINE_ID`
to match the explicitly selected engine. It creates only a uniquely named
container and temporary configuration, checks real health/HTTP/clean shutdown,
then removes them. Before supporting real users, adapt the Status Page full
fleet acceptance to verify your application's settings, backups and clone/load
behavior in disposable storage. Publish through reviewed image CI before using
the package for creation; production image admission still checks identity,
revision, digest, non-root user and health metadata.

## Profile boundaries

Use this small template when a health check can establish readiness and SIGTERM
can stop the application cleanly. It has one `/data` claim, generated JSON
settings, and stopped filesystem backups. Keep writable data under that claim;
do not add a Docker socket or arbitrary host commands.

Steam game installation, special readiness protocols and game-aware recovery
need their existing adapters; changing the template's image name does not add
those capabilities. Factorio keeps its official headless installer and existing
software-update UI. Managed Rust exposes its existing Steam setup/update and
paired recovery actions in **Software**. Legacy Rust installations retain their
existing delivery method and are never converted automatically.

Opening Software reads retained metadata. Checking Steam is explicit; applying
a reviewed build warns about downtime and paired world recovery. A failed or
interrupted operation may first need review in **Operations**. Inspect recovery
again after cancellation or a changed observation; returning after session
expiry never replays a mutation.
