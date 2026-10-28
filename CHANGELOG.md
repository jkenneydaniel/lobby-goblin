# Changelog

## 0.3.17-alpha — 2026-10-28

- Give automatic image-migration attempts unique operation IDs while preserving
  their migration correlation. Offer a guarded repair path for known legacy
  duplicate migration records without discarding history or replaying changes.
- Recognize the verified Docker Desktop proxy socket used by existing Windows
  installations. Retain ownership, engine-identity and management-mount checks,
  and continue rejecting arbitrary custom socket paths.
- Require durable evidence from the owning job before background worker cleanup.
  Keep unknown workers and interrupted operations available for inspection.
- Reject duplicate operation IDs before storage writes or reserved side effects,
  including related JSON and SQLite document writes. Keep legacy reads available
  for inspection and explicit repair.
- Show safe, actionable operation errors and keep bounded private diagnostic
  evidence, including original and cleanup failures. Keep Docker and broker
  transport details private and serialize concurrent diagnostic appends.
- Preserve updater/archive protocols, state contracts, pinned software providers
  and application images. Publishing does not deploy installations, restart
  servers or modify worlds.

## 0.3.16-alpha — 2026-10-28

- Simplify Updates to one installed version, one status and the relevant update
  action. Keep settings, help and technical details collapsed; show the host
  picker only when multiple hosts are connected.
- Keep game release browsing optional beside a direct link to server update
  controls. Preserve update confirmation, interrupted-update recovery and remote
  host scoping without changing updater protocols or application storage.
- Keep expanded details and unsaved settings during polling, preserve stale-save
  protection, and offer retry for temporary failures. Show newer releases over
  completed update history and avoid offering older releases to newer hosts.

## 0.3.15-alpha — 2026-10-28

- Support coordinated panel updates on Windows, macOS and Linux using private
  Docker-owned recovery storage, independent of native paths and host ownership.
- Support recognized legacy raw-socket fleets and agents without converting their
  registry, migrating game images or changing application containers and worlds.
  Retain original directory-mode operator recovery and add local named-pipe/Unix
  operator enrollment and recovery for older installations.
- Keep later installer/Fleet starts on the checked runtime and preserve interrupted
  update guards and metadata recovery. Older versions need one initial host-side
  upgrade to obtain the portable updater.
- Fix declared RCON commands in legacy Factorio preview helpers so the official
  runtime no longer needs the local map-preview compatibility patch.

## 0.3.14-alpha — 2026-10-28

- Restore administrator-driven management updates in the panel using the existing
  coordinated updater. Review a verified immutable release, confirm installation,
  reconnect and inspect the durable result for local or paired remote hosts.
- Run a narrowly scoped detached coordinator so replacing the broker, panel and
  controllers cannot interrupt their own update. Preserve private operator records,
  metadata recovery, forward-only committed recovery and the CLI fallback.
- Preserve installer files, historical updater archives and application containers,
  storage and worlds. Older installations need one host-side upgrade to enable
  the new broker capability. Publication does not deploy any installation.

## 0.3.13-alpha — 2026-10-27

- Add public curl/wget host-agent setup commands pinned to the panel release.
  Validate downloaded source before running the existing installer; keep Docker
  installation explicit and retain extracted-release and Windows setup support.
- Add administrator-only retained storage inspection, confirmed permanent deletion
  and recovery into an independent stopped server with fresh management credentials.
  Preserve original volumes and shared snapshots unless explicitly deleted.
- Preserve Factorio worlds, mods and presets, and Rust player progress, frameworks,
  exact software records and private cache permissions during recovery. Refuse
  interrupted changes, incomplete copies and unsafe metadata or storage links.
- Keep registry, snapshot and historical updater formats compatible. Publishing
  does not deploy installations or modify running servers or existing worlds.

## 0.3.12-alpha — 2026-10-27

- Let administrators enable management release checks and choose the stable or
  preview channel from Updates. Persist preferences across restarts and preserve
  existing host configuration as the initial default.
- Fix Rust seed overflow in new server creation and snapshot-before-removal.
  Verify legacy clamped seeds against the backed-up world, record the effective
  seed for independent copies, and continue rejecting unrelated mismatches.
- Preserve useful storage-worker errors for failed snapshots and removals. Allow
  isolated workers to read private game-owned backups within their existing
  mounts. Failed requested snapshots still block destructive removal.
- Speed up Factorio map drawing and selection with viewport indexing and a lazy
  terrain atlas. Preserve large modded objects and existing export limits; this
  does not change gameplay performance or expand the exported area.
- Add saved automatic map-refresh controls with separate permissions and bounded
  intervals. Keep the existing after-save refresh behavior as the default.
- Add safe draft-world cancellation, including protection against delayed preview
  callbacks recreating a discarded draft. Keep editing available after refusal.
- Preserve historical updater/archive formats and existing game image defaults.
  Publishing does not deploy installations, retry removals, restart servers or
  modify existing worlds.

## 0.3.11-alpha — 2026-10-27

- Add exact software-provider contracts, receipts and recovery records, with a
  shared digest-pinned SteamCMD base and isolated preparation workers.
- Offer new managed Rust installations with verified, pinned Steam builds and
  separate software/world storage. Preserve existing installation defaults;
  existing servers are not adopted or converted automatically.
- Support reviewed Rust software updates independently of game images, including
  Carbon/Oxide compilation validation and matching software/world/mod-data
  recovery. Preserve prior exact software caches and retain newer data privately.
- Protect managed plugin/configuration storage and keep executable-mod, framework,
  software and lifecycle permissions separate. Read protocol metadata from
  verified pristine files before startup without executing game code.
- Add a focused Rust Software screen for initial preparation, exact-build review,
  progress and inspected recovery. Handle expired reviews, interrupted checks,
  limited account permissions and session expiry without replaying operations.
- Check host/resources and snapshot installation compatibility before creation.
  Preserve disabled installation selections and discard stale check results.
- Include a minimal copyable application package and guide using the existing
  container provider, without custom panel code or a new generator framework.
- Preserve historical updater/archive formats, Factorio's official headless
  installer and existing game image defaults. Valheim and new ARM64 game support
  remain deferred. Publishing does not deploy or modify servers or worlds.

## 0.3.10-alpha — 2026-10-26

- Fix sign-in after session expiry inside a local or remote server view. Authenticate centrally, refresh server permissions and resume the current screen.
- Return newly unassigned accounts to their accessible server list. Preserve central login protections and avoid replaying server operations.
- Preserve historical updater formats and game image defaults. Publishing does not change existing installations, servers or worlds.

## 0.3.9-alpha.1 — 2026-10-26

- Verify published application images through each package's runtime provider, including Status Page's image revision, non-root user and health checks. Keep Factorio/Rust migration checks specialized to those games.
- Supersedes the incomplete 0.3.9-alpha draft; published image and Git tags remain immutable.

## 0.3.9-alpha — 2026-10-26

- Application packages own image recipes, runtime sources and checks. Shared image tooling and CI discover registered packages.
- Added a reusable single-container provider with shared lifecycle, health, JSON settings and stopped-data snapshots; Status Page proves a third package without panel code.
- Bound backup traversal before content reads and allow ZIP metadata separately from the 64 MiB data budget; exact-limit backups can be verified, published and cloned.
- Restore historical Factorio image-description commands and migration/recovery acceptance; native checks select the exact recipe build.
- Preserved historical updater layouts and existing game defaults. No deployments or existing-world migrations.

## 0.3.8-alpha — 2026-10-24

- Restore fleet update discovery with management release notes and host update
  guidance. Select Factorio image versions from the published catalogue.
- Remove deleted servers from the active list while retaining their storage for
  recovery. Inspect, verify, clone and delete shared snapshots from the panel.
- Add an opt-in Factorio runtime image that installs verified headless releases
  into persistent server storage. Keep bundled images as the compatible default;
  restarts and container replacements retain the exact installed version.
- Add explicit software upgrades with pre-update backups, version verification,
  durable recovery records and paired restoration of software and server data.
  Preserve the previous release and protect the recovery backup from cleanup.
- Use receipt-verified, read-only software copies for preview and world helpers,
  with private scratch mounts and exact-version cache identities. Runtime
  snapshots and clones retain their software version and archive checksum.
- Add independent runtime-image publication and require the published runtime
  before packaging release downloads. Publishing does not deploy installations,
  upgrade running applications or modify existing worlds.

## 0.3.7-alpha — 2026-10-24

- Package Factorio and Rust as registered application definitions with reusable
  screens, runtime profiles and native HTML extensions for specialized tools.
  Preserve installation identities, existing URLs and historical updater formats.
- Share navigation, sessions, accounts, status, operation progress, backups and
  confirmations across server and host panels, with desktop/mobile regressions
  and required static quality checks.
- Add explicit per-server delegated access, package-owned Factorio map and Rust
  framework/plugin permissions, and separate executable-mod and image grants.
  Keep existing administrator/read-only accounts and revoke changed sessions.
- Match download authorization to Factorio's historical world-download default;
  backup-download permission cannot access worlds by omitting the download kind.
- Preserve package-owned saved-setup cleanup during fleet account deletion,
  including atomic account/related-record deletion on transactional storage.
- Add bounded private audit history, correlated operation outcomes and recovery
  review. Retain interrupted work and refuse uncertain retries without replaying
  actions from history. Audit publication failures remain visible for review.
- Isolate Docker-host authority behind a local broker for new managed hosts,
  with scoped credentials, resource limits, revocation and owned-resource checks.
  Keep existing direct-socket installations compatible; conversion is review-only.
- Move Factorio helper work into private controller storage, verify nested input
  and output identities, and safely retire owned interrupted helpers.
- Add an explicit local management update command for broker-managed installs:
  engine-bound plans, metadata snapshots, held startup, pre-activation rollback,
  forward recovery after commitment and restart-safe runtime receipts. Management
  network reconnection waits for operator activation.
- Add compatible storage repositories and optional, reviewed transactional storage
  migration, export and offline recovery. Existing JSON storage stays authoritative
  until an operator explicitly selects the new backend.
- Preserve unresolved standalone-update history and required world restoration.
  Repair terminal audit publication for updates, host setup and agent updates.
  Cleanup failures no longer roll back a committed Rust framework change.
- Exercise extensibility with synthetic game and multi-service application
  fixtures. Production non-game Docker providers remain future work.
- Reuse the existing published Factorio and Rust images. Publishing this release
  does not upgrade installations, replace game containers or modify worlds.

## 0.3.6-alpha — 2026-10-22

- Add persistent panel-to-agent connections on a configurable dedicated port
  (24443 by default), with pairing-pinned TLS identities, concurrent transfers,
  heartbeats and reconnection. Support public, private and VPN addresses while
  preserving existing HTTPS pairings and reviewed installation files.
- Support public IPs and hostnames for hosted panel HTTPS with automatically
  renewing Let’s Encrypt certificates, using short-lived certificates for IPs.
- Add remote game hosts with manual agent installation/code pairing or reviewed
  SSH installation, scoped server controls and host selection during creation.
- Show agent/panel version alignment and offer administrator-confirmed agent
  updates with health checks and recovery, without replacing game containers.
- Add live Factorio Mod Portal and uMod libraries with Browse, Installed and
  Updates, administrator review, pinned downloads, dependency checks and recovery.
- Offer explicit automatic save/stop/apply/start for mod changes. Rust also offers
  running plugin load/reload/unload through Oxide or Carbon; Factorio requires a
  restart. Existing manual framework/upload tools remain available.
- Resume a previously running game after a failed mod preparation when the
  administrator chose automatic restart; preserve failed-job and recovery details.
- Authenticate paired-panel POST requests before buffering upload or JSON bodies
  on legacy HTTPS agents and hosted panels as well as persistent agents.

## 0.3.5-alpha — 2026-10-22

- Organize both game images under `images/`, supporting launchers under `scripts/`, and fleet templates under `deploy/fleet/`. Simplify the documentation while preserving historical release paths and compatibility with existing updaters.
- Add guided local and hosted installation, explicit prepare/start controls, and first-administrator onboarding without adopting existing servers or worlds.
- Automatically remove completed update workers and safely retire stopped, owned fleet helpers and completed migration originals. Failed update logs are retained with recovery records; running servers and data volumes are excluded.
- Publish one versioned, multi-platform GHCR image for the panel, controllers and setup tools. Setup pulls it; new release installations verify and pin its registry digest instead of building it on the host.
- Add Rust Carbon and Oxide / uMod installation, framework recovery, C# plugin installation/enable/disable/reload/removal and JSON configuration editing. Changes require a stopped server and preserve world and plugin data.
- Introduce the mod-capable Rust bootstrap `steam-lg.2` and complete modded backups, including loader files, plugin data and offline recovery copies. Existing first-party games are not automatically restarted to adopt this optional capability.
- Keep managed Carbon at its reviewed framework checksum by disabling its boot-time framework and hook self-updates; preserve other Carbon settings and require reviewed framework updates.

## 0.3.4-alpha — 2026-10-21

- Build a first-party vanilla Rust image from a pinned Node/Debian base and
  checksum-verified SteamCMD. Reuse installed Rust binaries and saved map identity;
  refuse silent game downloads over existing worlds with missing binaries.
- Automatically migrate supported older Factorio and Rust images when the new
  controller starts. Verify a backup, require a clean stop, pin the replacement
  by registry digest and preserve storage, settings, ports, limits and the prior
  running/stopped preference. Keep original container configuration and a protected
  backup, with a durable journal for interrupted migrations. Remove a verified
  standalone original without deleting data to avoid duplicate Compose services.
- Use first-party images for new servers and Factorio image updates. Remove
  third-party image choices; recognize historical images only for migration.
- Wait for Rust’s completed-startup health proof before reporting readiness or
  saving. WebRCON can respond while the world is still initializing. Preserve
  strict save-and-quit evidence for graceful shutdown.
- Advance the Factorio wrapper to 2.0.77-fc.3 without changing the game version.
  Preserve the restored WebRCON regressions, locked dependency checks and earlier
  standalone Rust recovery documentation.

## 0.3.3-alpha — 2026-10-21

- Add Host settings with the memory budget, allocated and remaining capacity,
  Docker memory capacity and a per-server game/controller allocation breakdown.
  Explain that allocations are limits rather than current RAM use.
- Let administrators change the budget without restarting games or the manager.
  Persist settings across restarts, protect concurrent edits, reject budgets below
  existing allocations and preserve at least 2 GiB of Docker headroom. Read-only
  accounts can view allocations; administrator and CSRF checks protect changes.
- Include stopped and incomplete servers in allocations, exclude removed servers,
  and show the 1 GiB controller allowance for each server. Improve creation errors
  with the required memory, remaining capacity and Host settings guidance.
- Add persistence, concurrency, validation and authorization regressions plus a
  disposable UI preview. Preserve the streaming and world retry fixes in 0.3.2.

## 0.3.2-alpha — 2026-10-21

- Let backup downloads outlive the generic proxy timeout at both web and host
  manager layers. Bound idle reads, respect client backpressure, cancel upstream
  requests when clients disconnect, and visibly fail interrupted transfers.
- Watch the relocated Factorio image validator in both image CI path filters.
- Keep interrupted first-world generation retryable with the same settings and
  password. Generate into a temporary save and publish without overwriting
  existing saves. Established identities with missing saves still require repair.
  This image-source fix awaits a separately published and adopted Factorio image;
  the existing fleet image digest is unchanged.
- Make fleet regression fixtures await operation completion and final persistence
  and exercise the real asynchronous child-controller handoff under delay.
- Retain the session-loading and sign-in-flash fixes from 0.3.1-alpha.

## 0.3.1-alpha — 2026-10-20

- Avoid briefly displaying sign-in when opening a server or returning to the
  host manager. Keep authentication and server controls hidden until the shared
  session check finishes, with an accessible loading message. Apply the same
  behavior to Factorio, Rust and standalone panels.
- Preserve sign-in and invitation registration when signed out or when a session
  request fails. Add delayed-session regression coverage and repair the isolated
  Factorio preview asset list.

## 0.3.0-alpha — 2026-10-20

- Keep explicit world generation disabled after provisioning. A fresh Factorio
  boot creates its first identity; imported, cloned and switched saves never
  trigger generation of a competing default world.

- Add an opt-in, separate single-host manager with Factorio/Rust server creation,
  resource limits, automatic port allocation, one login, scoped game controls,
  isolated named volumes and private bridges. Existing standalone deployments
  remain unchanged. Recover network attachments after manager recreation.
- Add a shared, verified snapshot library. Clone saved worlds into fresh storage
  with fresh credentials; exclude configuration and access lists. Preserve Rust
  map identity and player progress. Server removal saves/stops cleanly and retains
  its data volume and snapshots. Disable standalone updaters in managed mode.

- Rename the panel and repository to Lobby Goblin. Refresh both game interfaces,
  setup guides, image metadata and release tooling. Keep historical update
  assets, repository settings and Factorio image labels readable for upgrades.

- Add an isolated Rust module with WebRCON status/players, lifecycle jobs, logs,
  stopped-server settings and streamed identity backups with verification,
  downloads and scheduling. Ship a prepare-only standalone installation template
  with separate credentials, storage markers and container ownership checks.
  Keep Factorio the default and disable Factorio update jobs in Rust installs.

- Extract a shared web/controller core and a built-in Factorio module. Retain
  existing installation configuration, routes, state formats and backup layouts.
  Keep Factorio commands, worlds, maps, setup and update compatibility in the
  game module. Include nested runtime sources in release/image checks.

## 0.2.6-alpha — 2026-10-19

- Include saved enemy units alongside spawners and worms on the map. Preserve
  enemies when the object cap is full, prioritizing bases over unit swarms;
  render visible red markers above other objects and support enemy inspection.
  Existing snapshots need a fresh export to include units.

- Avoid repeated ownership scans of overlapping Factorio data directories while
  retaining checks for every file and custom data path. Prepare image revision
  `2.0.77-fc.2`; installed image selections remain unchanged.
- Cache seed/version metadata for 30 seconds, refreshing after process/world
  changes and operations. Keep player and playtime queries live.
- Give background map exports lower CPU priority under contention, without a
  hard CPU quota. Add an isolated, generated-world benchmark and record results
  and rejected candidates in `docs/PERFORMANCE.md`.

## 0.2.5-alpha — 2026-10-17

- Speed up world-creation previews by matching Factorio preview threading to the
  existing one-CPU worker limit. Keep the full 1024-pixel image and map coverage.
- Start the first draft preview immediately and show completed renders sooner;
  retain the slider debounce and slower polling while previews are queued.

## 0.2.4-alpha — 2026-10-17

- Fail setup before creating private data if the image lacks a valid CA bundle
  or working Docker/Compose/Buildx clients. Test the actual release ZIP against
  the built image, first-time preparation and a rerun that preserves private data.
- Gate installer asset attachment on the same fresh-registry, restricted-build
  and packaged-setup smoke checks used in CI.

- Include the Docker CLI's trusted CA certificate bundle in the panel image so
  detached update builds can authenticate to Docker Hub from a fresh client.
- Retain bounded, redacted Docker failure diagnostics in update records and worker
  logs, with distinct certificate, timeout and output-limit errors. Exercise a
  real restricted-container registry request and build in CI.

## 0.2.3-alpha — 2026-10-17

- Add an administrator-only Check for updates action that bypasses the six-hour
  cache, with a one-minute request limit and visible checking state. Reveal the
  panel update review action when release detection changes on the open page.
- Refresh the controller release check during panel review so a stale controller
  cache cannot block a newly detected release.

## 0.2.2-alpha — 2026-10-16

- Add an independently built x86-64 Factorio image from pinned Debian and the
  checksum-verified official headless download, with first-party startup/RCON
  tools. Keep existing worlds, settings, identity and mod selections intact.
- Support Factorio Tools and Lobby Goblin images in the panel, including
  reviewed same-version source changes and separate image revisions. Validate
  compatibility before replacement and pin the downloaded image digest.
- Verify both image sources with read-only amd64/digest preflight checks and
  recognize the actual RCON version response after replacement.
- Add isolated runtime tests and an explicit build/test/publication workflow;
  keep current installation defaults and running servers unchanged.

- Add configurable backup cleanup windows, exact deletion reviews and optional
  daily retention. Exclude manual/pre-change archives by default; protect newest
  copies, verified recovery archives and required update backups. Keep cleanup
  under the server operation lock without issuing game or Docker commands.

- Add guided, read-only diagnostics for the panel/controller, Docker, game state,
  host architecture, storage access and free space, with next steps and a
  support report that excludes credentials, raw logs and private configuration.
- Save world drafts to each administrator account, including unfinished JSON
  and invalid input. Resume from the world library after reloading or signing in.
- Save up to 20 private custom presets. Loading keeps the current world name
  and seed; resumed drafts and presets never preselect switching the game.
- Detect conflicting saves from another tab and offer a downloadable draft copy.

## 0.2.1-alpha — 2026-10-16

- Combine the v0.2.0-alpha setup, interface, onboarding and updater work with
  the controller improvements that were previously only installed locally.
- Reduce idle controller CPU by caching saved-map metadata until the snapshot
  file changes, including lightweight map-status requests. Automatic refresh
  after completed saves remains enabled.
- Preserve the local controller image override outside Git and use LF line
  endings for the executable Mac setup shortcut.

## 0.2.0-alpha — 2026-10-16

- Guided Windows and Mac/Linux host launchers, a Finder shortcut, read-only
  prerequisite checks, explicit startup and save-import/recovery choices.
- Explicit amd64 game/worker selection on ARM64 hosts; panel services remain
  native. Temporary workers reuse the installed game image ID when available.
- Host setup/troubleshooting guide and platform matrix distinguishing emulated
  game support from native panel builds and actual host validation.
- Simulated host-launcher coverage and a Mac/Linux/Windows CI matrix.
- Whole-panel charcoal/forest styling, amber actions, official outline icons,
  responsive navigation and consistent forms across every management page.
- Dedicated Play style / Customize / Review world creation, grouped resources,
  retained drafts during navigation, revealed validation errors, creation feedback,
  searchable/filtered worlds and actual generated-preview thumbnails.
- Resumable first-run browser onboarding after owner registration, server-side
  readiness/first-save checks, connection guidance and persisted completion.
- Automatic public GitHub release notifications for administrators, preview/stable
  channels and offline mode. No unattended updates.
- Administrator-triggered in-panel updates: staged/checksummed panel releases,
  a detached Compose worker, persistent progress, source/config/state recovery,
  and separately selected Factorio patch upgrades with explicit save recovery.
- Release installer metadata and local source baselines; modified installations,
  unsupported migrations and mount/port changes block automatic replacement.

## 0.1.0-alpha

Initial public alpha source release.

- Docker-packaged game, browser panel and internal controller.
- Private administrator/viewer registration and account management.
- Server controls, player administration, settings and sanitized logs.
- World library, save import/download, configurable generation and live previews.
- Full backup verification, schedules, restore and failed-load recovery.
- Automatically refreshed saved-map overview and shared pins.
- Optional live player positions with per-world achievement warning and backup.
- Portable environment configuration, Docker-only first-run setup and recovery.
- Allowlisted source packaging and GitHub test/build automation.

Targets Factorio 2.0.77 and trusted LAN use. See README for alpha limitations.
The alpha source is not automatically deployed to existing installations.
