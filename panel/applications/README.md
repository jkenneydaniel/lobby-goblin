# Application packages

Each supported game or application has one directory here, including its image
sources, tests and build declarations. Register its ID in
`registry.json`; the loader reads only those explicitly registered packages.

```text
applications/example/
  definition.json       Docker/runtime configuration and supported capabilities
  presentation.json     Shared screens and declared custom extensions
  index.js              Optional adapter for specialized runtime behavior
  images.json           Package image recipes and checks
  images/               Image sources, metadata and native acceptance
  public/               Custom browser code, templates and styles, when needed
```

`factorio/` and `rust/` are the first production packages. Their existing image
references, environment settings, container names and storage layouts are kept.
Changing this source organization does not adopt or restart an installation.

## Standard behavior

Definitions describe the service roles, image policy, ports, configuration and
capabilities. The shared panel supplies authentication, navigation, ordinary
screens and operation history. Standard screens need no application-specific
browser code. Definitions use a fixed data format; runtime behavior belongs to
registered code.

Packages selecting `managed-container-v1` receive an adapter and default
presentation automatically. See the [authoring guide](../../docs/APPLICATION_PACKAGES.md).

A specialized adapter exports the application through `index.js` and uses the checked
definition from `definitionFor(id)` in `../registry.js`. Existing games use the
shared managed Docker profile with adapters for their protocols and save formats.
The reusable service-application factory supplies the equivalent controller and
screens for non-game service profiles. The single-service container profile provides production Docker provisioning.
Multi-service Docker providers and Laravel hosting remain separate work; their
current conformance tests use synthetic providers.

## Custom functionality

An integration can declare extensions for features such as Factorio worlds and
map previews, or Rust mod management. Browser controllers, native HTML templates
and styles live in that package's `public/` directory. The web adapter declares
their served routes and sets `publicRoot` to that directory. Shared assets remain
owned by the panel.

Extensions use the existing screen lifecycle and permission checks. They do not
replace the product shell. Backend adapters implement the corresponding protocol
or data-format operations through the shared controller.

## Package permissions

Declare custom grants and their labels in `contract.policy.permissions` using
`application.<package-id>.<feature>`. Bind them to actions and endpoint methods in
that same contract and to screen visibility in `presentation.json`. Custom
browser controls use the shared permission/action checks. Account editing and
per-instance assignment use the registered declarations automatically.

An action's `permission` or an endpoint policy may be a permission name, a
nonempty array requiring **every** named grant, or `null` for administrator-only
access. Arrays can narrow a shared permission, never remove a protected shared
requirement. Rust uses `["mods.manage", "application.rust.plugins.manage"]` for
both manual plugin operations and catalogue installs/recovery. Its framework and
configuration permissions have the same executable-mod prerequisite. Factorio
declares separate map viewing, generation, pin and tracking grants.

Adding a grant does not rewrite existing account assignments. Keep shared
permissions for ordinary behavior; document any newly required package grants
when separating existing features. See [server access](../../docs/ACCESS.md).

## Adding support

1. Add the package's definition and presentation.
2. Export its adapter from `index.js`, selecting shared runtime behavior where
   available and implementing only the application-specific differences.
3. Add its ID to `registry.json`. Image metadata is derived from the registered
   definitions; there is no second image registry to edit.
4. Check registration, permissions, normal screens and any custom extensions in
   disposable fixtures before using the package with an existing installation.

The package tests register both an additional game and a non-game application
without changing shared panel code. Built-in migration checks also exercise
prepare-only installers, retained configuration paths and legacy update archives.
