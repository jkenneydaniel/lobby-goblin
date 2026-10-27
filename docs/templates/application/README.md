# Minimal application template

Copy this directory using [the application guide](../../ADDING_AN_APPLICATION.md).
The example serves configurable HTTP content on port 8080 and stores only
`settings.json` under `/data`. It uses the standard container provider and has
no custom panel code. It is deliberately absent from the application registry.

Files to customize:

- `definition.json`: identity, image policy, ports, resources and JSON settings.
- `images.json`: explicit build files, source checks and native acceptance.
- `images/image.json`: registry/tag/platform and pinned base image.
- `images/Dockerfile`: matching labels, non-root user, health and shutdown.
- `images/server.mjs`: the application process.
- `images/server.test.mjs`: local source behavior checks.
- `images/acceptance.mjs`: real-image smoke test on an empty disposable engine.

No code generation or additional provider framework is required. Replace the
example's source and checks rather than treating an HTTP smoke test as proof of
a game's world persistence or recovery.
