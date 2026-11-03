# Application packages and shared core

Lobby Goblin has a shared web/controller core and registered Factorio, Rust and
Status Page packages. Factorio remains the default for standalone installations.
The opt-in [host manager](FLEET.md) provisions isolated instances of registered
packages; it is a separate Compose project and never adopts an existing standalone
server.
Modules remain built in rather than downloadable plugins.

The authoring model is an explicitly registered application package.
[Definitions and capability extensions](APPLICATION_DEFINITIONS.md) cover games,
non-game service profiles and specialized tools such as maps. Factorio and Rust
select the same standard browser host and ordinary screens from JSON declarations.
Rich capabilities use package-owned native HTML templates and scoped controllers.
Application protocols and storage codecs remain reviewed backend adapters.
The production `managed-container-v1` provider supports one image-owned process,
typed public configuration and bounded stopped-data snapshots; Status Page is
its real HTTP application. Production multi-service hosting, private runtime
providers, deployment tasks and database-aware recovery remain separate work.
See [application packages](APPLICATION_PACKAGES.md) for enforced limits and the
[support matrix](SUPPORT.md) for implemented, fixture-only and planned capabilities.

## Checked module interfaces

Each built-in game declares a version 2 contract in its `contract.js`. It owns
feature availability, supported actions and confirmations, safe recovery retries,
controller routes and their HTTP methods/roles, and backup strategy/format.
`core/application-module.js` validates registration and web hooks; `core/game-contract.js`
checks configuration, explicit action/route permissions, namespaced game grants,
shared browser screen metadata, image policy, bounded helper declarations,
the controller lifecycle, action implementations and updater
interfaces before the listener starts. Historical v1 adapters remain readable through an
explicit compatibility policy; built-in games use the complete v2 declaration.
Game parameter validation remains inside
the module and is awaited before accepting a job. The conformance suite instantiates
both real game adapters without contacting a host or starting a game.

The core defines common endpoints once in `core/routes.js`. Web proxies, instance
controllers and remote gateways consume that policy. Modules cannot relax shared
route permissions. `/capabilities` exposes serializable contract metadata.
`/status` adds `statusVersion: 1` and a common `summary`, including a nullable
online-player count and readiness state. Existing fields remain available:
Factorio still returns its player-name array and Rust its numeric player count.
Unknown counts remain `null`.

## Operations and restart recovery

`core/operations.js` coordinates instance actions and host creation, publication
and removal using the existing `jobs.json` array and host registry. It persists
reservations and stages before effects, serializes controller history writes,
and retains the operation lock through cleanup and final persistence. A completion
or cleanup failure records a required recovery review and prevents subsequent
operations. Existing completed records without the new metadata remain readable.
No persisted-state version or directory migration is required.

Operation request IDs deduplicate repeated submissions within retained history.
They are scoped to actor, action and a canonical input hash; inputs and credentials
are not copied into the journal. The shared browser client retains a request ID
after an uncertain response so a retry can recover the original job. Child start
and backup requests also carry stable parent-derived IDs. This is bounded
single-process coordination, not a multi-replica queue or a power-loss guarantee.

Startup marks unfinished records for review without replaying their actions.
Administrators use the shared recovery panel to check outcomes. Instance start/stop
can be reconciled from current status or explicitly retried after inspection;
restart, world changes and host operations are never blindly replayed. Host
inspection verifies owned resources or registered snapshot integrity using reads.
Acknowledgement records who reviewed an uncertain operation and leaves its
original outcome marked interrupted. Partial server allocations and data volumes
remain in place for reviewed follow-up. Existing update, image-migration and mod
transaction journals retain their specialized recovery behavior.

A checked common history now projects ordinary jobs, independent updates,
mod/framework transactions, host setup and agent updates through administrator
`/operations` and `/operations/recovery` endpoints. Native records retain an
additive `operationRecord` envelope and phase observations; the public projection
excludes credentials, raw transaction files and private recovery paths. Games,
non-game packages and fleet hosts select the same native-template history
component. See [operation records and recovery](OPERATION_MODEL.md) for the
provider contract, authoritative stores and recovery limits. The global shell now projects administrator-only native active/recovery
records through the enriched jobs response, retaining host/session scope. This does not replace specialized recovery rules or establish a database
transaction across native JSON files.

The fleet web shares accounts/sessions and mounts no Docker socket or game data.
Explicit `/servers/<id>/` URLs delegate existing game controls. The trusted fleet
controller owns the registry, resource budget, port allocation and shared library.
Each game has an instance controller, private bridge, named volume and fresh
secrets. Instance Docker calls verify ownership labels and the exact data mount;
preview workers receive only that instance's work subdirectory. Snapshot workers
copy completed backups, strip credentials, verify hashes and clone into new
volumes. The source volume is never mounted writable by another game.

[Remote hosts](REMOTE_HOSTS.md) use a persistent TLS 1.3 HTTP/2 connection opened
by the panel on the agent’s configurable dedicated port (default 24443).
`fleet/agent-identity.js` persists the certificate identity and includes its
fingerprint in the one-time pairing code; `fleet/agent-connection.js` verifies
that pin before sending credentials, multiplexes streamed responses, keeps the
connection alive and reconnects without replaying interrupted commands. Existing
HTTPS pairings remain compatible.
`fleet/hosts.js` stores outgoing credentials privately and incoming hashes; the
agent gateway exposes only approved host/game routes. `host-install.js` creates
an agent-only installation without accounts. `fleet/host-setup.js` binds SSH
fingerprint review to the administrator and exact plan, then installs/pairs with
credentials held only in memory. `fleet/agent-update*.js` journal and replace the
two management containers while leaving game containers and storage in place.
Agent-only startup skips automatic game-image migration. Remote game URLs are
scoped by host and server; accounts and sessions remain in the main panel.

## Repository and installed layout

The shared runtime stays under `panel/`. Container build sources for both games
live under `images/`; host helper scripts live under `scripts/`. Release packaging
maps these sources to historical installed paths instead of changing installed
mounts, identifiers or updater validation rules. See [repository layout](REPOSITORY.md)
for the mapping and deliberate exceptions for runtime deployment templates.

## Responsibility boundaries

| Component | Owns |
| --- | --- |
| `panel/core/web.js` | Sign-in, sessions, CSRF, account administration, viewer/admin enforcement, controller proxying and static asset allowlisting |
| `panel/core/accounts.js` | Account/invitation persistence and password/role rules, with an account-deletion hook for module data |
| `panel/core/controller.js` | Controller authentication, persistent jobs and their operation lock, backup scheduling/retention, update coordination and HTTP lifecycle |
| `panel/core/backups.js` | Archive storage, verification records, checksums, listing and health; asks the module to collect and validate game data |
| `panel/core/host.js`, `docker.js` | Docker requests, container lifecycle and resource sampling; no game commands |
| `panel/core/archive.js`, `files.js` | Bounded ZIP processing and file listing |
| `panel/core/game-images.js`, `image-migration.js` | Owned image contracts, migration-only historical recognition and journalled replacement; game-specific consistency remains in module backup/stop/readiness hooks |
| `panel/core/standalone-migration.js`, `panel/fleet/migrations.js` | Compose/registry ownership checks, operation coordination and durable environment/controller changes for automatic image migration |
| `panel/applications/registry.json`, `index.js` | Explicit package registration and loading; defaults to Factorio without new environment settings |
| `panel/applications/factorio/` | Factorio transport, readiness, telemetry, saves, settings, world generation/switch/restore, map workers, drafts/presets, installation preparation and update/image compatibility |
| `panel/applications/rust/` | WebRCON, ownership/readiness checks, lifecycle, stopped-server configuration, streamed identity archives and a standalone prepare-only installation template |

Shared helpers for authentication, management repositories, retention and release sources
retain compatible entrypoints. Package declarations select the shared ordinary
screens and allowlisted extension assets, preserving existing public URLs. `panel/public/shell.js`, `shell.css` and `client.js` supply common navigation,
account identity/sign-out, scoped URLs, status, operation progress, feedback,
confirmation dialogs and browser transport for fleet, Factorio and Rust. Rust
retains its `rust_session` cookie and separate standalone account storage.

## Managed game definitions

Each built-in game supplies a version 1 `managed` adapter from its own
`managed.js`. `core/managed-game.js` checks the contract and derives the public
catalogue and creation validation from the same definition. The adapter owns:

- Image resolution, published ports, data mount target and backup subdirectory.
- Resource/player defaults, bounds and additional numeric creation fields.
- Game and instance-controller environment variables.
- New-volume preparation and configuration after any snapshot has been restored.
- Snapshot content collection, restore, compatibility and player-data metadata.
- Optional historical image-migration participation and standalone paths/names.

`FleetManager`, the storage worker and snapshot coordinator delegate those rules;
they retain ownership checks, budgets, port reservations, fresh credentials,
empty-volume requirements, hash verification and atomic snapshot publication.
The game-specific archive extraction remains inside each game module. Existing
Factorio ZIPs, Rust identity archives and snapshot manifests keep their formats.
Legacy migration machinery still recognizes historical image contracts; it is
not a general migration mechanism for future games.

`core/instance.js` and `core/owned-docker.js` hold shared identities and scoped
Docker checks. The historical fleet exports remain compatible. Controller route
exposure comes from `core/routes.js` in the web, fleet and remote gateway.
Fleet accounts use the core account store and one transaction queue; modules
provide optional account-data extensions and deletion hooks. Factorio drafts
and presets keep their existing account/server scope and storage paths.
Packages return related transactional deletions through
`web.accountDeletionRecords(accounts, user, snapshot)` before the account commit,
and clean legacy files through `web.deleteAccountData(accounts, user, snapshot)`
after it. The fleet forwards the same storage snapshot through both hooks.

The third-game fixture in `panel/test/fleet.test.js` provisions TCP ports and
custom storage, publishes a snapshot and clones independent data through these
services. It does not register or ship another production game.

## Shared product shell

Application and fleet entry points mount the same browser shell. Package
presentations select shared screens and declared extensions; the shell owns the header, navigation presentation,
current account, status, operation strip, messages and general confirmation
dialog. Ordinary screen controllers live in the shared application host; rich
forms and their backend policies remain with their packages. Setup gating is opt-in: fleet waits for setup completion, while
Factorio hides navigation only inside its unfinished guide and retains "Do this
later" navigation. Rust has no guide and retains navigation for newly registered
owners. The shared client owns JSON/raw requests, current-session CSRF,
session-expiration handling and non-overlapping polling.

The shell uses explicit local/remote server URL scope. Hash changes never remove
that pathname, including world creation, registration and setup. Standalone
entry points, cookies and HTTP routes remain compatible. Shared assets are
allowlisted centrally, including for packages with a separate public asset directory.

Initial job persistence must succeed before an operation starts. Both the game
controller and host manager restore their previous in-memory history and release
the operation reservation if that write fails. General job recovery and the
single-process storage model otherwise retain their existing semantics. The subsequent
permission and audit layer is described in [server access and isolation](ACCESS.md).

## Frontend workflow boundaries

The browser remains plain ES modules with no bundler or framework migration.
Entry points own navigation, authentication presentation and data orchestration;
feature modules own their forms and local drafts. Shared workflows receive a
request function, current-session controller, confirmation/notification callbacks
and operation/busy adapters rather than importing a game entry point.

| Browser component | Owns |
| --- | --- |
| `public/shared/session.js` | Current session, bootstrap, sign-in/registration, password renewal and sign-out |
| `public/shared/operations.js` | Accepted operation tracking, polling, recovery callbacks, busy state and completion after the backend releases its lock; never replays work |
| `public/shared/accounts.js` | Password confirmation, signed-in sessions, invitations and account administration for all three panels |
| `public/shared/backups.js`, `public/backup-retention.js` | Archive listing/verification/download, schedule and cleanup forms; Factorio opts into restore, Rust opts into interruption consent |
| `public/shared/view.js`, `public/workflows.css` | Escaping, common value formatting and shared workflow presentation |
| `applications/factorio/public/factorio/*-views.js` | Overview, worlds, map, players/activity and settings/update rendering through explicit state/helper inputs |
| `applications/rust/public/rust/mods-page.js` | Framework review, plugin controls/configuration and local review state |
| `public/fleet/creation.js`, `public/fleet/host-settings.js` | Catalogue-driven creation and host-budget drafts, revision conflicts and reload/save behavior |

Account and backup components are disposed on navigation/session loss so stale
loads cannot replace a newer screen. Backup completion preserves an unsaved
schedule. Password renewal replaces the session/CSRF used by subsequent requests.
Game consistency, authorization, backup validation and interruption rules remain
on the existing backend; the shared presentation cannot grant permissions.

Browser imports resolve through explicit shared and package asset maps. The
application entry is `/app.js`; the fleet entry is `/fleet.js`, with its screens
under `/fleet/`. Unused compatibility asset wrappers have been removed;
fleet setup no longer mutates a game module's asset map after construction.
Static checks resolve imports under standalone, local-server and remote-host
paths. JSDoc contracts in `public/shared/contracts.js` provide strict checking
without adding a runtime dependency or changing historical archive file types.
`public/application/contracts.js` and the strictly checked routing/action-form
implementations extend that boundary to definition-driven screens. Both game
entrypoints now register specialized capabilities with `mountApplication`;
ordinary authentication, overview, tables, configuration, logs, backups, access,
mod-library and diagnostics use shared components. Factorio's configuration
constraints are consumed by the browser and server from its presentation file.
Specialized Factorio world/editor/preview, map/live tracking, setup and update
markup lives in declared HTML assets, while Rust mod markup uses its own template.
Both use native DOM composition; capability code cannot embed or parse HTML under
the static quality gate. Shared screen rendering accepts template nodes and
expires old listeners before replacing them.
See [development quality gates](DEVELOPMENT.md#static-quality-gates) and the
[local consolidation evidence](verification/frontend-quality.md).

## Module contract

`startController(module, options)` and `startWeb(module, options)` accept a trusted
module object. `panel/applications/factorio/index.js` is the production example;
`panel/test/shared-core.test.js` supplies a different, test-only game with no
Factorio world files, commands or account extensions.

The definition supplies:

- `id`, `name`, `releaseRepository`, optional `stopTimeout` and explicit `routes`.
- `configuration(env)`, returning the container and data/state/library/backup paths.
- Optional `validateInstallation(config)`, checked before any controller state
  initialization. Rust requires matching ownership markers on all storage roots.
- `createController(context)`, returning game behavior described below.
- `createUpdater(options)`, supplying the update/recovery interface used by the
  core. Factorio's updater retains its existing installation-specific Compose
  checks, detached worker, pinned images and explicit restore recovery. Another
  game needs its own update policy; it must not reuse Factorio's image validator.
- `diagnostics(options)`, providing metadata-only game/platform diagnostics.
- `web`, declaring its account class, session cookie, assets, account routes,
  administrator-only read routes, request size limits, onboarding readiness
  validation and diagnostic report composition.

The controller context provides configuration, environment, the host/Docker
transport, tracked timers (`every`), current jobs/active operation/schedule,
backup storage, updater, `runJob`, `stageMessage` and `imageMigrationPending`.
Background game work must defer mutations while image migration is pending. Updater and backup accessors
are available after controller creation; use them from runtime hooks/actions,
not while constructing the adapter.

The controller adapter supplies:

| Interface | Contract |
| --- | --- |
| `actions`, `validateAction(body)` | Explicit game actions and request validation; public jobs cannot invoke arbitrary commands. Confirmation rules stay with the game. Core backup/verification/cleanup actions are reserved. |
| `status()`, `recentStatus()`, `locations` | Game-specific status and sanitized diagnostic context |
| `handle(req, res, url)` | Game HTTP endpoints, restricted to the definition's declared routes |
| `backupFiles(label, options)` | Obtain a consistent game snapshot and return archive entries; the game owns save-completion semantics and required files |
| `validateBackup(buffer)`, `backupVerified(result)` | Validate the game's archive layout/content and describe verification; archive integrity is distinct from a successful game-load restore |
| Optional `writeBackup(target, label, options)`, `verifyBackupFile(file)`, `backupExtension` | Stream game archives without the ZIP buffer limit. Rust uses `.tar.gz`, complete stopped-identity inventory and per-file hashes. Listing, download, verification and retention use the declared extension; Factorio defaults to ZIP. |
| Optional `validateSchedule(value)` | Game-specific acknowledgement before enabling scheduled backups; Rust requires interruption consent. |
| `init()`, `start()` | Recover module jobs/helpers and start background work; timers use `context.every` and are cleared when the controller closes |
| `waitIdle()`, `beforeJob(job)`, `afterJob(job, params)`, `invalidate()` | Coordinate game background work with shared jobs/updates and invalidate status after operations |

The updater supplies `init`, `refresh`, `status`, `plan`, `install`, `restored`,
`jobs`, `busy`, `pendingRestore` and `current`, preserving the existing recovery
contract. Update reservations must cover backup creation and worker launch.
`install(input, actor, {gameOnly})` must validate the saved plan kind before any
update effects when `gameOnly` is true; client-supplied plan fields are not authority.

Game actions are serialized by the core's operation lock. Module workers must
respect that lock and updater reservations. HTTP mutations retain the existing
role/assignment and CSRF checks in the web service and bearer authentication in
the internal controller. Declaring a frontend control never grants backend access.

The [mod library](MOD_LIBRARY.md) shares review pinning, file journals, recovery
and UI under `panel/core/mod-*` and `panel/public/mod-library.*`. Game adapters
own upstream metadata, dependencies, paths and lifecycle semantics. Factorio
requires a stopped process; Rust can explicitly opt into framework hot apply.
Both reuse the core job lock and web authorization/CSRF checks. Administrators
can delegate executable mod operations with an explicit `mods.manage` grant;
provider credentials remain administrator-only. Read-only review
never performs lifecycle actions.

## Permission and audit boundaries

`core/permissions.js` owns the additive assigned-server role, grant validation,
reserved shared-route policy and scoped session projection. Game action and
endpoint permissions come from the selected module contract; custom grants use
`game.<module-id>.<permission>` names. Core administrative routes and reserved
backup actions cannot be relaxed. The compatibility action map applies only to
callers without a new module policy. Game screen declarations under
`public/<game>/screens.js` are consumed by both browser and backend validation. `core/web.js` checks grants
before proxying; `fleet/web.js` checks assignment before resource lookup and
constructs the minimal assigned-server list. Existing admin/viewer contracts
retain their historical access. Shared browser access helpers present the same
capabilities; the backend remains authoritative. Permission changes use the
existing account transaction queue, revision checks and session invalidation.

`core/audit.js` owns serialized private audit stores, chained event verification,
retention and paginated history. Web request events are separate from controller
operation/recovery outcomes. It records fixed metadata and safe access deltas,
not request bodies or game content. One writer serves parent and child web panels;
controllers keep their own stores beside existing state. A started write precedes
mutation submission, and an outcome write precedes the HTTP response. Audit
failure after effects produces an uncertain outcome requiring review.

`public/shared/permission-editor.js` and `audit-history.js` mount inside the
shared Accounts workflow for administrators. Unavailable assigned resources
remain listed so their grants can be revoked. General operation recovery stays
administrator-only; mod recovery is included in the explicit executable-mod grant.
See [the access, history and isolation contract](ACCESS.md) for full policy,
storage limits, game-image scope and the remaining Docker-host trust boundary.

Image reference/label/architecture rules live with each game and are registered
in `applications/image-policies.js`; the shared image resolver checks immutable digests.
Legacy image recognition stays in the migration compatibility facade. Games also
declare preview executable/names, exact Docker archive-read paths and bounded
command helpers. The broker retains its fixed resource, mount, network, argument
and worker-count ceilings. A declaration cannot register HTTP-supplied policy.

## External Docker boundary

Fresh fleet and agent definitions use `core/docker-broker.js` as the only
socket-owning service. `core/broker-client.js` selects the explicit Unix transport
without fallback; per-instance ownership checks execute in the broker, not only
in controller code. `core/broker-policy.js` restricts host provisioning, and
`fleet/broker-compose.js` declares separated socket/credential/state mounts.
Controller and host web APIs retain their existing account, CSRF and route gates.

Legacy transport is preserved when broker configuration is absent. Broker mode
refuses an unconverted registry and does not run legacy image migration or
socket-bearing agent self-update helpers. `fleet/broker-upgrade.js` produces a
pure review plan from supplied metadata, with no read/write/engine/apply behavior.
See [Docker isolation](ISOLATION.md) and [local evidence](verification/docker-broker.md).

## Existing installations

The original shared-core refactor preserves the contracts below. Separately,
v0.3.4 performs a one-time, backup-protected image migration after installation;
see [the image migration contract](IMAGE_MIGRATION.md). Persistent account and
world paths remain unchanged. The migration updates the owned image reference
and, for Rust, its instance controller configuration.

Compatibility retained by the application-package refactor:

- `server.js`, `setup.js` and the detached `update-worker.js` process entrypoint
  remain available. Internal callers use the current core/package modules;
  obsolete re-export files have been removed.
- Compose services, ports, explicit installed images, mounts, UID/GID policy, Factorio environment
  variables and the `factorio_session` cookie name retain their existing values.
- Accounts/invitations, account-owned drafts/presets, jobs, schedules, retention,
  map metadata/pins, live-tracking consent and update/recovery records retain their
  existing paths and formats.
- World ZIPs, full backup ZIPs and their manifest/verification records keep their
  existing layout and validation rules. Existing worlds are not rewritten.
- Factorio HTTP routes and frontend asset URLs remain the same. No new game
  selector or Rust controls are exposed in an existing installation.
- The image copies `core/` and the registered `applications/` packages. Both the legacy-compatible update ZIP
  and complete source ZIP include these nested paths under the existing `panel/`
  allowlist; updater/state contract versions remain unchanged.

Editing source does not deploy it. Prepare a normal tested release before an
installation upgrade. Keep the live game and existing worlds untouched during
refactoring and validation; fixture tests use temporary data and mock Docker.

## Adding an application or game

Implement the interfaces above in a new built-in module, register it explicitly,
and provide its reviewed runtime/installation adapter. A checked presentation
selects standard components and declared actions; ordinary packages use
`core/application-web.js` and require no application browser implementation.
`applications/{factorio,rust}/presentation.json` demonstrate the shared tools;
the Arena browser fixture demonstrates a custom action without game UI code.
Only specialized capabilities need a reviewed extension provider. Register its
assets and lifecycle explicitly; it uses the same session, scoped request,
operation, navigation and disposal services as ordinary screens.
Test at least readiness, safe shutdown, save consistency, backup/restore, update
failure recovery and backend permissions using disposable fixtures first.

Register the package once in `panel/applications/registry.json`, implement its adapter,
and add contract, lifecycle and snapshot fixtures. Generic fleet provisioning,
storage workers and shell code should not need game-ID branches.

The non-game fixture and `core/service-application.js` also exercise independent
web, queue and scheduler roles, dependency/readiness checks, typed configuration,
revision/hash pinning and outcome inspection. These profiles are synthetic, not
a production Laravel offering. Package, template, operation, persistence and
management-lifecycle evidence is tracked in
[the completion ledger](verification/platform-completion.md).

Do not expose arbitrary module paths or downloadable executable plugins. Do not
assume another game has a Factorio-style world ZIP, pause state, map exporter or
achievement consent. Managed servers use per-instance data, credentials and
operation locks; existing standalone installations are never adopted implicitly.

## Rust isolation

`GAME_MODULE=rust` explicitly selects Rust in its standalone stack. Omitting it
keeps the legacy Factorio behavior. Rust setup refuses existing destinations or a
destination inside the Factorio checkout. All generated service/container names,
network, data roots, controller/account state and secrets belong to a new instance.
The controller validates storage markers before shared state writes, then checks
the Rust container's labels, image and data bind mount before commands/mutations.
It cannot run Factorio world/map actions or the Factorio updater. See
[the Rust guide](RUST.md) for supported operations, archive limits and runtime
acceptance boundaries. In-panel restore and automatic Rust updates are outside
this module's current scope. Game-load recovery is a separate acceptance test.

## Product naming

Lobby Goblin is the product and repository name. Historical update archive roots,
worker names and published Factorio image labels are compatibility identifiers;
they remain readable through `panel/branding.js`. Release packaging also emits
historical asset aliases for already installed updaters. New panel builds and
workers use Lobby Goblin names. Existing installation directories and state are
never renamed automatically. See [the update guide](UPDATES.md#lobby-goblin-naming-compatibility)
for older release checks after the repository rename.


### Management storage boundaries

`core/storage/` defines repositories for accounts/assignments/invitations,
controller jobs, audit history, host/remote registries, host setup and shared
configuration. Existing JSON remains authoritative until a reviewed offline
migration activates a private database marker. The transactional backend uses
revision checks, atomic document batches, schema/migration identity checks and
bounded SQL transactions without asynchronous application work inside them.
Audit append alone retries pure metadata conflicts; operations and account
mutators never replay automatically. Migration preserves the original JSON. Checked module-owned account records
can join the same atomic batch; filesystem coordination fences cooperating
writes and retains interrupted leases for explicit offline review. The operator
CLI plans/migrates/exports management documents and recovers only into fresh
storage directories.

[Management storage](STORAGE.md) describes the profiles, compatibility boundary,
crash/conflict evidence and operator recovery.
[Management updates](MANAGEMENT_UPDATES.md) documents the separate Docker operator
workflow and metadata-only cutover. Specialized module files and native workflow
journals remain under their owning packages.
