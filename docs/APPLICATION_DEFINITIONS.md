# Application definitions and capability extensions

Status: the checked definition, shared presentation and service-lifecycle paths
are implemented locally. Factorio and Rust use the package model; the non-game
conformance package uses synthetic providers. A production single-container provider is available. Multi-service host
provisioning and Laravel hosting remain future
product work. Current acceptance is tracked in the
[completion ledger](verification/platform-completion.md).

The single-service production container provider and package-driven builds are
documented in [application packages](APPLICATION_PACKAGES.md). Multi-service
Docker hosting remains separate work.

## Package layout

Each integration now lives in `panel/applications/<id>/`, including its runtime
adapter and custom browser assets. `applications/registry.json` is the single
registration list; image metadata follows the registered definitions. Shared
screens and components stay in `panel/public/`. See the concise
[package authoring guide](../panel/applications/README.md).

The package change keeps current Docker images, environment variables and
persistent paths. It removes the old `games/` runtime tree and unused import
wrappers. It does not migrate or restart a deployed server.

## Current implementation checkpoint

- `panel/applications/{factorio,rust}/presentation.json` select shared overview,
  record tables, configuration, logs, backups and accounts. Both browser entry
  points are four lines registering only their specialized capabilities. Separate
  game authentication, ordinary screen controllers and page documents are gone.
- Their `definition.json` files own the managed runtime profile, image policy,
  catalogue defaults, ports, storage targets, helper declarations and environment
  bindings. A checked compiler produces the established host/controller adapter.
  Snapshot codecs, storage preparation and game protocols remain reviewed code.
  Existing environment output, installation paths and game identities are
  preserved; this introduces no automatic adoption or definition-marker migration
  for existing game installations.
- Shared action forms handle Factorio moderation, announcements and its
  restricted console. Settings types/ranges are read from the same declaration
  by the browser and server. Nested Settings sections preserve delegated
  image-change access without offering diagnostics or general settings reads.
- Extension lifecycle hooks save drafts before navigation/sign-out, clear private
  state on session end and prepare required status before rendering. Failed draft
  storage retains the editor and URL. Preview dialogs belong to the capability
  activation and are removed when it closes.
- `core/application-presentation.js` checks data-only descriptors, component
  vocabulary, fields/ranges, action/endpoint references, shared configuration
  permissions and declared extension assets. `public/application/` owns the
  shared document, templates, controllers and application shell composition.
  Descriptors cannot provide HTML, executable expressions or import paths.
- The Arena fixture uses the same host with no game browser implementation. A
  separate non-game fixture uses a JSON definition and the reusable
  `core/service-application.js` adapter for web, queue and scheduler roles. Its
  process drivers are synthetic; they never contact Docker or PHP.
- `core/application-services.js` validates dependency graphs, combines required
  health, starts dependencies before consumers, verifies reverse-order stops and
  keeps unknown optional processes unsafe for configuration/backup. Recovery
  inspects all services instead of resolving a partial start from primary health.
- New service applications require an existing private definition marker with
  both revision and canonical content hash. The controller cannot create or
  migrate this marker. The initial JSON configuration provider requires stopped
  services, typed values and revision checks. Private secret references resolve
  through registered providers, separately from public configuration. Drivers and
  deployment tasks receive only their service's declared references.
- Optional reviewed deployment steps use the common operation journal. The
  synthetic fixture initializes storage, rebuilds caches and applies a simulated
  database migration with explicit `application.web-stack.deploy` authority.
  Starting services does not deploy implicitly. Unknown outcomes require
  inspection and cannot be automatically retried or rolled back.

This proves a working definition-to-controller-to-browser seam. Production
multi-service host integration remains a separate provider implementation.
Factorio's rich world editor/preview, map/live players, setup and update views
now use separate native HTML template assets declared by their extensions. Shared
loading/composition helpers bind instance values through DOM properties; a static
quality rule prevents capability controllers from embedding or parsing markup.
Production Laravel recipes, ingress, real deployment/secret providers and
database-aware backups are future product work; the factory does not register a
production Laravel hosting option. Synthetic provider tests prove contracts and
recovery behavior, rather than PHP execution or container isolation.

## Checked runtime vocabulary

`core/application-definition.js` registers bounded, immutable JSON data and binds
its identity, presentation and public service metadata to the module. Accessors,
functions, unsupported prototypes, unsafe keys, sparse arrays, unknown fields and
profiles are rejected before runtime work. Public metadata omits private runtime
configuration, image policies and secret-provider references.

The compatibility profile `managed-game-v1` describes one required game service
using the established amd64 instance layout. `core/managed-definition.js`
compiles it into the existing provisioning interface without adding game branches
to shared host policy. Definitions select image admission and bounded helper
workloads; they cannot raise the broker's privilege ceiling, replace management
controls, choose arbitrary controller paths or inject privileged creation defaults.
Environment bindings concatenate explicit literals, checked instance fields and
approved secret slots. They contain no expression evaluator or shell expansion.
Workload environment names are separate from restricted management environment
names. Existing game snapshots and storage codecs remain explicit adapter hooks.

Non-game services select registered profiles with their own configuration
validators and role support. A profile owns runtime behavior, readiness, scoped
storage and any deployment tasks. An instance/request cannot register a profile,
provider, command or host path. Adding a supported application definition needs
no browser code; introducing a new execution protocol requires reviewed code.

## Private providers and deployment recovery

Definitions list private reference identifiers and provider identifiers, never
values. Registration rejects missing providers and undeclared service references.
The controller resolves references privately and passes each service only its
allowed subset. Public definitions omit these references. Runtime logs, driver
errors and health responses are scrubbed using resolved values before returning
through the panel. This is a provider seam, not a secret-management product or a
promise to detect arbitrary encodings of a secret emitted by application code.

A deployment policy contains an ordered bounded list of registered tasks, fixed
service targets, explicit confirmation and a separate permission. Standard table
components render its observations and action. Every task requires an inspector
with three outcomes: `complete`, `absent` or `unknown`. **`absent` must prove that
no task remains active and submitting it is safe**; a missing final artifact alone
does not prove absence. A database provider that cannot prove this returns
`unknown` and prevents submission.

All services must be definitively stopped before deployment and between steps.
The journal records submission before invoking a task and records verified
postconditions afterward. Lost responses are accepted only when the inspector
proves completion. An uncertain submission remains interrupted across controller
restart, blocks mutations and exposes inspection without replay. A failed task
with proven absence can be reviewed and submitted again explicitly; already
verified steps are skipped. No generic database rollback is attempted.

The disposable fixture persists simulated provider observations across controller
recreation and exercises scoped private configuration, shared/private storage
names, lost responses and uncertain migrations. Real providers must supply their
own transactional deployment identity, durable postconditions, readiness and
backup consistency guarantees before production hosting is offered.

## Product boundary

The panel manages applications. A game server is one application type; a Laravel
site, bot or background service can be another. An application instance may have
several cooperating services, with an explicit primary service and separate
worker, scheduler or dependency roles. Supporting these roles is part of the
definition contract, rather than a special case added after a single-container
game abstraction is complete.

The existing checked adapters, permission policies, lifecycle controls and broker
are useful infrastructure. Separating each game's JavaScript into smaller files
does not establish the intended authoring model. Standard screens now use the
shared host; rich capability and runtime contracts still require completion and
the final complete-change review.

## Three authoring surfaces

| Surface | Owns | Does not own |
| --- | --- | --- |
| Versioned application definition | Identity, service roles, reviewed runtime profiles, ports and HTTP exposure, persistent storage, resource defaults, typed configuration, lifecycle policies and capability selection | Page HTML, browser event handlers, host commands or actual secret values |
| Shared panel components and workflows | Authentication, navigation, overview, service status, logs, operation progress/recovery, configuration forms, backups, access and audit presentation | Game-specific protocols or unsafe guesses about backup consistency |
| Optional reviewed adapters and extensions | Protocol translation, save/readiness barriers, configuration codecs, deployment hooks and specialized tools such as maps | Replacement authentication/navigation, relaxed authorization or arbitrary Docker-host access |

Definitions are data. A small fixed vocabulary selects supported components and
runtime behavior; this must not become a general programming language in JSON.
Shared form fields describe types, ranges, defaults, help text and view/edit
permissions. Validation runs on the server as well as in the browser. Secrets use
private references, are redacted from reads, and are never shipped in the public
definition.

Ordinary application authors should not need to write browser code. Existing
protocol/configuration providers can make a simple definition sufficient. An
unsupported protocol may need a small backend adapter; that should not require
another frontend application.

For a genuinely specialized interface, an extension provides a component,
template and stylesheet through a documented lifecycle. Markup belongs to the
component/template layer, with loading and behavior in its controller. Shared
components own ordinary layout and controls. Moving duplicated HTML strings to
separate template files alone does not meet the requirement.

## Native extension views

A reviewed extension registers its fixed script and HTML asset in
`module.web.extensions`. Its controller loads that asset with the shared
`public/shared/templates.js` loader, clones a named native `<template>` and
assigns values using `textContent`, `value`, `checked` and other DOM properties.
The existing screen context accepts either template nodes or historical shared
views, so capabilities can migrate without replacing sessions or routes. There
is no expression evaluator or additional browser framework.

Factorio's `applications/factorio/public/factorio/{worlds,map,setup,updates}.html` own their respective
page, form and row structures. `capabilities.html` supplies the small common view
primitives used by these tools. The world editor retains draft/preview/settings
behavior in its controller and view-model functions; it does not carry page HTML.
Rust's reviewed mod capability uses its own HTML asset. The static quality gate
rejects embedded markup and HTML-parsing sinks in either game's capability code.
The same pattern is available to future tools, including a Rust live map or
application-specific deployment inspector, without giving them a separate shell.

Templates are bundled reviewed assets, not user-supplied definitions. The data-only
application definition still selects capabilities and permissions; adding an
unsupported protocol or specialized UI remains reviewed executable code. Native
templates alone do not implement a new application runtime or hosting recipe.

## Definition and instance identity

Separate the definition schema version, the package revision and an installed
instance's selected revision. Validate definitions before registration; reject
unknown component/provider identifiers, fields, permissions and endpoint/action
references. Compile them into the existing checked authorization/runtime
contracts. There must be one authoritative declaration rather than parallel
manifests and handwritten contracts that can disagree.

An instance records the reviewed definition revision and resolved runtime
images. Installing a newer definition must not silently change running commands,
images, mounts, ports, limits or configuration. Changes use a reviewable migration
plan and explicit application through the operation/recovery system.

Start with bundled, reviewed definitions and extensions. Importing a definition
with executable installation/deployment logic is a separate trust decision. A
definition cannot grant itself permissions, elevate a container, mount the Docker
socket, choose arbitrary host paths or expand the broker's ceilings.

## Runtime model

The shared runtime contract describes:

- One or more named services with stable identities, roles, dependencies and
  independent readiness/health. An application must not report healthy merely
  because its web process is ready while a required worker has failed.
- Reviewed images and process profiles with argument arrays, bounded helper
  workloads and service-specific resource limits. Application code and hooks run
  within their application boundary; they do not receive host administration.
- TCP/UDP listeners and optional HTTP ingress, persistent storage claims,
  writeable paths and private secret references.
- Configuration providers that read/write supported formats within declared
  storage. Paths, interpolation and generated content are validated by the
  provider, rather than evaluated as arbitrary shell text.
- Install/deploy/start/stop/backup/restore hooks with explicit prerequisites,
  interruption policy and postcondition checks. Operations retain the actual
  component outcomes and uncertainty across management restarts.

The initial implementation should provide the necessary seams and conformance
fixtures without attempting a Kubernetes-sized scheduler or a full hosting
business. HTTP routing, certificates, build/deploy integrations and managed
databases remain explicit product work; a flexible schema does not prove those
features work.

## Laravel as a real non-game conformance case

A Laravel definition must be able to describe a web service, optional long-lived
queue workers and a scheduler, shared application storage and external database
or cache connections. Deployment can require initialization, cache generation,
explicit database migrations, readiness verification and worker reloads. These
are distinct steps with their own permissions and recovery consequences.

Database migration rollback is not equivalent to rolling back a container image.
The operation model must preserve that distinction and never automatically replay
an uncertain migration. Secret changes must not leak through public manifests,
job history, logs or audit metadata.

This is a conformance requirement for the architecture, not a claim that a
complete Laravel hosting product already exists. Validate the multi-service model
using synthetic images and disposable storage before introducing a real hosting
recipe.

References: [Laravel deployment](https://laravel.com/docs/13.x/deployment),
[queues](https://laravel.com/docs/13.x/queues) and
[scheduling](https://laravel.com/docs/13.x/scheduling).

## Game capabilities remain first-class

Optional capabilities preserve the depth of the existing game tools:

- Factorio opts into world management, map generation and map preview. The
  adapter retains engine-specific validation, save consistency and isolated
  preview helpers.
- Rust can opt into a live map extension with its own supported data provider,
  coordinates, refresh/event behavior and player visibility policy. A live Rust
  map is a proposed feature, not an existing implementation. Required plugins
  need separate explicit executable-mod permission and operator review.
- A Laravel application can opt into deployment, worker and scheduler tools
  without receiving world, player or map controls.

A map capability can reuse presentation primitives for tiles, images and markers
while leaving game-specific data collection in the adapter. Rich editors need
not be forced into the same component as a read-only map. Extensions use the
shared session, API client, scoped permissions, operation reporting and disposal
contract. Unavailable providers are reported explicitly; the panel does not
install a plugin or restart a server to enable them automatically.

## Source layout and migration

The intended authoring layout is an application package containing a
`definition.json`, optional backend adapter/provider files and optional capability
extensions. The shared panel renders the standard experience from the validated
public projection. A standard package has no `app.js`, auth implementation or
copied overview/settings/backups pages.

Implement and prove one complete definition-to-runtime-to-browser path before
expanding the schema. Use that path for both existing games and a synthetic
non-game application. Remove the corresponding duplicated presentation as each
shared capability is adopted.

Historical game identifiers, environment keys, routes, installation locations,
container/volume identities and on-disk formats remain compatibility boundaries.
Introduce the application vocabulary at the new authoring layer and bridge legacy
adapters deliberately; renaming stored `game` fields across installations is not
a migration strategy. Keep specialized game semantics behind adapters while
retiring separate ordinary browser applications.

All work remains uncommitted. No existing installation, running server or world
is part of acceptance. Engine tests use the dedicated disposable host and fresh
fixtures only.

## Completion evidence

1. Add a basic third application using its definition and existing providers,
   with **zero frontend code** and no application-specific branch in shared core.
   It receives sign-in, navigation, status, configuration, logs, operations and
   permission filtering from the same panel components.
2. A synthetic Laravel-shaped application proves multiple service roles,
   dependency failure, shared/private storage, secret redaction and explicit
   deployment steps. It must not inherit game-only assumptions.
3. Factorio and Rust use the same standard capability implementations. Existing
   game-specific map/world/mod journeys retain their behavior and authorization.
4. An optional extension exercises mount/load/refresh/dispose, permission changes,
   late responses, operation completion and provider unavailability through the
   shared lifecycle. Extensions cannot relax server/broker authorization.
5. Definition validation and compatibility tests reject unsupported versions,
   typos, undeclared actions/providers, secret exposure and attempted host access.
   Existing fixture installation identities, configuration and world bytes remain
   unchanged until an explicitly reviewed fixture migration is applied.

This extends priorities 1 and 2 of the platform completion work. Common operation
history/recovery, transactional repositories, management upgrade/recovery,
disposable runtime acceptance and the final full-change review remain required.


## Related management data

Reviewed adapters with private account data can declare checked storage groups
alongside their other contracts. Shared repositories provide conditional writes,
atomic related-record commits and offline migration/export/recovery; the module
supplies the data codec and retains format ownership. Factorio drafts/presets are
the first implementation. This does not add frontend requirements to ordinary
application definitions or let data-only definitions run storage code. See
[Management storage](STORAGE.md) for the contract and maintenance boundary.

## Software delivery is separate from image admission

Each service may declare `software` alongside its runtime `profile` and
`configuration`. The image policy still admits the container runtime; software
policy selects how that runtime obtains and maintains application binaries.
Omitting `software` preserves the image-bundled behavior for existing packages.

Bundled binaries use:

```json
"software": {"version": 1, "mode": "image"}
```

A runtime that installs software into persistent application storage uses:

```json
"software": {
  "version": 1,
  "mode": "runtime",
  "provider": "factorio-headless",
  "initial": {"channel": "stable"},
  "storage": "application-volume",
  "updates": "manual"
}
```

`initial` contains either one channel or one exact `version`. Provider names
select reviewed code registered by the application/runtime adapter. A definition
cannot supply an executable, shell command, credential, download URL or host path.
Changing the declaration does not add an installer to an incompatible image.

Image revisions and software versions are separate identities. In runtime mode,
changing Factorio or a Steam application does not inherently require a new image.
Images still receive explicit revisions for wrapper, library and OS changes.
The installed software and its receipt must remain in the application volume;
writing only to the container's writable layer would lose that version when the
container is replaced.

The shared initial-version resolver requires a reviewed provider implementing
`resolve`, `installed`, `empty` and `install`. It performs no installation itself.
It resolves a channel only when the provider verifies empty application storage,
and returns an exact selection for the installer to verify and durably record.
An existing receipt is checked and reused without querying a newer release.
Missing files, changed/foreign receipts and populated storage without a receipt
require explicit recovery or migration. Ordinary startup never upgrades software.

The current declarations describe Factorio's bundled image and Rust's existing
SteamCMD bootstrap separately. New managed-server records retain their own policy,
and release lookups can select that record's policy rather than assuming the
current package policy applies to every older server. Legacy records are not
rewritten or migrated by this source change.

Factorio runtime-mode discovery uses Wube's official version API, independently
of published image tags. Wube's free Linux headless package is the preferred
installer source for this provider; SteamCMD remains appropriate for applications
whose dedicated servers are distributed through Steam. Selecting a Steam branch
must record its installed build identity; a branch name alone is not a pinned
version or proof that a historical build can be installed.

Factorio also exposes an explicit runtime delivery option through its reviewed
managed adapter. The alternative image policy is independently validated; its
software policy uses the same checked declaration. New managed records pin their
selected mode. The default bundled image, old records and standalone defaults
remain compatible. See [Factorio runtime software](FACTORIO_RUNTIME.md) for the
installer, durable update/recovery, exact backup and snapshot identity, and
receipt-verified read-only helper copies. No existing installation is migrated by
loading these definitions.
