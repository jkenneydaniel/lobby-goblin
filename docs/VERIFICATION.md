## v0.3.6-alpha release preparation, October 22, 2026

- PR #9 merged as `a30eb4e324dc777951fb97a74dbf3c5336312940`. Its
  post-merge Test and build, shared runtime and both game image checks passed.
- Aligned the package/lockfile, runtime label, installer/Compose defaults,
  controller version and CI/release image references at `0.3.6-alpha`.
- The release-version Node 24 suite passed 332 tests with zero failures and
  one platform-specific skip; the Factorio Python suite passed all 20 tests.
  The Node suite includes complete-source and compatible archive checks against
  frozen v0.2.0/v0.3.3 updaters and prepare-only installer fixtures.
- Both game image source trees are unchanged from `v0.3.5-alpha`. Anonymous
  registry reads verified the published Linux amd64 images and contract labels:
  Factorio `2.0.77-fc.3` at
  `sha256:b7c0b2e8f17e53cb9e1f0cfbf55e2a6a7d4e09a9f78c9ac9b524170e224e9de1`,
  and Rust `steam-lg.2` at
  `sha256:26bcf68356e2a6918ee1e52ffc4901d97ee5c64caae74a5446fe63539653374a`.
  Both follow the same immutable-tag policy; unchanged game sources do not
  require replacing either published image.
- These are release-preparation results. Hosted release checks, runtime
  publication and final assets require separate completion. No deployment,
  existing installation, running server or world was accessed or changed.

## Unreleased: PR 9 feedback, October 22, 2026

- Node 24 regression: **332 passed, zero failed, one skipped** (333 total).
- Both games resume a server cleanly stopped by automatic mod installation if
  preparation fails before the transaction starts. Already stopped games remain
  stopped, Rust hot mode stays online, and pending recovery still blocks startup.
- Nine added fault-injection regressions cover failed recovery-copy setup,
  post-stop file revisions, failed restarts and recovery gates. They first
  reproduced the relevant failure paths; world sentinels remain unchanged.
- Full release/updater, permission and transport checks passed. All lifecycle
  actions are synthetic; no real game host, running server or world was touched.

## Unreleased: final diff review, October 22, 2026

- Node 24 regression: **323 passed, zero failed, one skipped** (324 total).
- Corrected remote Factorio previews to accept the paired panel/user namespace
  while retaining separate preview sessions for local users and different panels.
  The regression uses a blocked preview queue and no game workers or Docker.
- Corrected agent recovery to launch its detached helper from the current owned,
  cached runtime. Recovery no longer depends on downloading an unavailable target
  image; the regression refuses all image/registry operations and preserves games.
- The complete suite retains mod-library, pairing, streaming, permissions,
  installer, release privacy and frozen updater compatibility checks. Syntax and
  staged diff checks passed. All new host activity used disposable fixtures.
- No deployment, real game host, running server or world was accessed or changed.

## Unreleased: persistent agent connections, October 22, 2026

- Node 24 local regression: **321 passed, zero failed, one skipped** (322 total).
  Nine dedicated transport tests use disposable TLS/HTTP/2 servers and synthetic
  Docker only: stable private identity, certificate pinning before credentials,
  connection reuse, multiplexed large downloads/uploads, byte-bounded backpressure,
  cancellation, truncated transfers, reconnect without command replay, stalled-handshake shutdown,
  manual pairing, panel restart, live-session revocation and pinned health probes.
- Fresh preparations default to TCP 24443, accept a configurable dedicated port
  and private/VPN addresses, and publish no agent ports 80/443. Existing HTTPS
  manifests, pairings and canonical installation records remain compatible.
  SSH setup carries the complete fingerprint-bearing pairing code. Fake Docker
  update checks preserve the agent port, transport environment and identity mount.
- Chrome verified the private-address/custom-port setup review and dedicated-port
  manual guidance using the synthetic loopback UI. No installation was submitted.
- Source/runtime packaging, privacy checks and frozen v0.2.0/v0.3.3 updater
  compatibility passed. Syntax and diff checks passed.
- No Docker daemon, real SSH host, game process or world was accessed. The
  updated runtime image was not built or published. Native container startup,
  external routing/firewalls and Windows/macOS agent launcher acceptance remain
  separate checks. Nothing was deployed. New agents use pairing-pinned TLS;
  the earlier ACME record below still applies to hosted panels and legacy agents.
  See [connection setup and limits](REMOTE_HOSTS.md).

## Unreleased: public IP and hostname HTTPS, October 22, 2026

- Node 24 local regression: **311 passed, zero failed, one skipped** (312 total).
  Nine HTTPS tests cover public IPv4/IPv6 and hostname configuration, private and
  reserved address rejection, explicit Let’s Encrypt/short-lived IP profiles,
  persistent certificate storage, no-SNI policy, exact origin checks, Secure
  registration cookies, manual/SSH preparation and unchanged older manifests.
- The official Caddy 2.11.7 macOS ARM64 archive passed its published SHA-512
  checksum. Its `validate` command accepted the generated hostname, IPv4 and IPv6
  configurations with all network access denied. This did not start a gateway
  or request certificates.
- Chrome used the disposable loopback preview: private-IP rejection and public
  IPv4/IPv6 setup reviews passed; IPv6 URLs use brackets. No setup was installed.
- Source/runtime packaging and frozen v0.2.0/v0.3.3 updater compatibility passed.
  The release privacy guard remains intact; RFC 1918 validation fixtures use
  numeric octets rather than literal private deployment addresses.
- No Docker daemon, real SSH host, game process or world was accessed. Public
  ACME issuance, automatic renewal over time, external reachability and native
  container gateway startup still require separate disposable acceptance.
  Nothing was published or deployed. See [HTTPS setup](INSTALLATION.md#hosted-reachability).

## Unreleased: remote game hosts, October 22, 2026

- Node 24 local regression: **302 passed, zero failed, one skipped** (303 total),
  including the preserved live mod library and frozen updater compatibility checks.
- Thirteen host tests cover expiring/single-use pairing, retry after a lost
  response, revocation, private credential persistence, scoped game routes,
  administrator/viewer/CSRF checks, manual preparation and unchanged reruns,
  SSH review ownership/expiry, and generated script syntax.
- The actual SSH client/server ran only on disposable loopback fixtures. Probing
  sent no authentication; confirmed fingerprints allowed the synthetic command;
  changed fingerprints prevented authentication and execution.
- Fake Docker checks cover management-only replacement, unhealthy rollback,
  foreign ownership refusal, stale/expired update reviews, immutable runtime
  verification, interrupted recovery, overlapping requests and lost start replies.
  Game/container sentinels and storage remain unchanged.
- Desktop Chrome checks passed manual pairing, SSH review/confirmation,
  synthetic setup progress, reviewed agent alignment, remote Rust creation
  destination, scoped Factorio controls and viewer-only host access.
- Release bundles contain all agent/runtime files, import the agent modules and
  retain compatibility with frozen v0.2.0/v0.3.3 updater validators.
- No real Docker daemon, remote host, game process or existing world was used.
  Real SSH bootstrap, agent container replacement, public HTTPS and Windows/macOS
  agent launchers remain outside this acceptance. Nothing was published or
  deployed. See [setup and operational limits](REMOTE_HOSTS.md).

## Unreleased: live mod library, October 22, 2026

- Node 24 local regression: **289 passed, zero failed, one skipped** (290 total).
  The skip is the Linux ownership check on macOS. Syntax and diff checks passed.
- Eighteen dedicated mod-library tests cover Factorio dependencies, compatible
  updates, conflicts, private download credentials, stale/expired reviews,
  checksum failures, explicit stop/start, Rust hot command dispatch, disabled
  updates, Carbon paths/commands, permissions, outside edits and interrupted
  recovery. World/settings/configuration sentinels remain unchanged in fixtures.
- Both real web modules reject unauthenticated/viewer library access and reject
  mutations without administrator CSRF verification. Frozen updater validators
  and extracted runtime/package checks include the new library files.
- Desktop Chrome checks used the actual Factorio/Rust UI with loopback-only,
  synthetic in-memory catalogues and jobs. Browsing, searching, Installed,
  Updates, lifecycle choice, review/cancel/confirm and simulated hot update passed.
- No Docker engine, game process, running server or existing world was accessed.
  Native dependency/game compatibility, asynchronous compilation and real plugin
  reload still need separate disposable runtime acceptance. These checks do not
  establish deployment or live gameplay acceptance. See [usage and limits](MOD_LIBRARY.md).

## Unreleased: full isolated Ubuntu installer acceptance, October 22, 2026

- Built the matching Linux amd64 runtime and exercised the real installer in a
  fresh, isolated Ubuntu 24.04 machine with its own Docker engine and private
  test registry. Nothing was published or deployed to an existing installation.
- Real Docker bootstrap, Node-free guided setup, healthy manager startup,
  administrator registration, onboarding, recovery, rerun preservation and
  account persistence passed. A separate synthetic workload and its storage
  stayed unchanged. No game/world was created.
- Corrected Unix/PowerShell temporary installer helper permissions: explicitly
  run that helper as root while preserving invoking-user file ownership on Unix.
- Hosted account flows and certificate persistence passed with a private test CA;
  public ACME issuance and external reachability remain unverified.
- Linux regression: **264 passed, 0 failed, 1 skipped** (Lua unavailable).
- Image artifact, digest and detailed boundaries: [installer acceptance](INSTALLER_ACCEPTANCE.md).

# Release verification

## v0.3.5-alpha preparation: cleanup, published runtime and Rust mods

These are local preparation checks, not a deployment or registry publication.
No running installation, existing world or live Docker resources were changed.

- Node 24: **245 passed, zero failed, one skipped** (246 total) on macOS and in
  an isolated Linux container with no network or Docker socket. The macOS skip
  is the Linux ownership check; Linux passes that check and skips the absent Lua
  interpreter. Linux launcher fixtures require executable temporary storage;
  the successful run used an executable tmpfs and ordinary dependency files.
- Shared runtime images built for **linux/arm64 and linux/amd64**. Both served
  Factorio and Rust pages/health and included controller/worker entrypoints in
  disposable, read-only, network-disabled smoke tests. The packaged ZIP matched
  the ARM64 image byte-for-byte; first-time setup and a safe rerun passed without
  a Docker socket, network or game. The updated `steam-lg.2` Rust image built.
- Cleanup tests reject running, foreign, mismatched and raced containers,
  preserve interrupted migrations, retain failure logs, and use non-forced
  container deletion without volume flags. A real, uniquely labelled disposable
  stopped Docker container was removed through the shared cleanup function.
  No global prune or cleanup of an existing installation was performed.
- Update tests cover published runtime download/digest pinning, multi-platform
  Docker inspection, release/source/version mismatch, missing digest and rollback
  without a game restart. Both example Compose configurations and workflow YAML
  parsed; launcher syntax checks passed. Registry publication itself has not run.
- Framework tests cover pinned reviews, changed downloads, archive path/link
  refusal, stopped-server requirements, external edits, interrupted transactions,
  recovery/startup blocking, plugins and stale JSON configuration edits. Version 1
  backups remain supported; version 2 preserves mod files/data and recovery state.
  Modded backups are refused by world-only cloning to avoid dropping their mods.
- Actual official Carbon `production_build` and Oxide `2.0.7830` archives were
  installed in disposable directories, backed up, verified and extracted. Carbon
  recovery verified **163 files**; Oxide verified **124 files**. Their active loader
  markers, plugin sources and world sentinel survived extraction; switching to
  Vanilla restored original DLL sentinels. This proves package/file recovery,
  not native framework loading. Archive checksums were respectively
  `ff0e1bb8c81edd2a4a31df39776f231004840af4c2f71ba9acbbe465b9479037` and
  `a5e9de373b9ee6c6d03232c90c95caf24c40749e4ea40ef6b2a6d8cdaa854cd4`.
- Playwright exercised the real web/controller/auth routes with synthetic game
  responses: administrator stop confirmation, framework review/install, plugin
  upload, JSON load/save, disable and enable. Viewer/admin and CSRF route checks
  passed separately. The fixture used temporary directories and no Docker socket.
- **Native Carbon/Oxide loading and compilation have not been validated here.**
  The game-image publication workflow now requires `rust --fresh --mods` on an
  amd64 Docker host: both loaders, a compiling/executing/reloading probe plugin,
  complete modded backup recovery and Vanilla restoration. This gate is configured
  but has not been executed in this work. Earlier vanilla migration acceptance
  below does not prove these new framework scenarios. Existing first-party games
  and their registered controllers are not automatically replaced to enable mods.

## v0.3.4-alpha preparation: owned images and automatic migration

The source is based on v0.3.3-alpha and retains the restored WebRCON, dependency
lockfile and historical Rust recovery changes. These checks prepare source and
images without installing the release in an existing deployment.

- Node 24: **235 passed, zero failed, one skipped** (236 total) on macOS and in
  an isolated, network-disabled Linux container. The Linux run passed the root
  ownership test; the Lua interpreter was unavailable. Python Factorio image
  runtime tests: **20 passed**. Both example Compose configurations validated.
- Migration tests cover running and stopped Factorio/Rust, backup/image failure
  before replacement, ownership and custom-wrapper refusal, rename/create/config
  interruptions, controller recreation/start interruption and resumption, exact
  network/mount/resource settings, protected recovery backups and verified
  standalone retirement without deleting storage. Full standalone worker tests
  check image-only environment edits, file permissions, recovery environment and
  Rust controller/installation metadata.
- The shared HTTP operation gate rejects mutations while migration is pending
  and clears only after the recorded image is actually installed. Snapshot
  compatibility tests cover pinned digest references and older image snapshots;
  newly provisioned Rust clones explicitly permit a first Steam installation.
- The public panel image built. Its packaged installer passed first-time setup
  and a safe rerun with no network, Docker socket or running game. The actual
  **v0.3.3-alpha updater source** accepted all four new ZIP variants (complete
  source and compatibility archives, current and historical asset names).
  Every variant includes the shared migration and custom Rust image sources.
- Rust image tests cover fresh/existing installs, saved seed/size, missing binary
  refusal, identity/symlink protection, a restricted temporary Docker build
  context, startup health and shutdown evidence. An early WebRCON response cannot
  mark an initializing world ready or allow save/stop operations. Rust's
  self-termination is recognized only
  after the supervisor's acknowledged save, observed save completion and explicit
  game quit; unrelated signals/nonzero exits remain failures.

Native Windows x86-64 Docker acceptance (new private fixtures, no host ports):

- Factorio **passed** the real legacy-to-owned migration, same-world readiness,
  configuration/password/mod-list preservation, saved-state backup recovery,
  stop/start/restart and unchanged resource/port settings. The old game formatted
  `mod-list.json` during its own shutdown without changing its contents; the new
  wrapper retained the stopped source file byte-for-byte. The legacy exit was
  143 with current-run save/Goodbye proof; all three owned-image stops were zero.
  All containers, networks and volumes for that run were removed.
- Rust **passed both complete suites**: legacy-to-owned migration and a fresh
  SteamCMD installation on an empty volume. SteamCMD reported app **258550**
  successfully installed, and the new server reached completed startup.
- Both Rust suites preserved installed binary/configuration hashes, the same
  seed **456** and size **1000**, player/settings queries, 30 rapid WebRCON
  requests and unchanged resource/port settings. After changing the running
  world to **18.5**, archive recovery returned **13.38351** (migration) and
  **13.37822** (fresh), within tolerance of the saved **13.37** marker.
- Both suites exercised the real HTTP controller's status, empty player list,
  bounded logs, settings, verified backup, stop, edit, start and restart. The
  edited eight-player limit was visible after restart. All **14 game exits** and
  **two HTTP-controller exits** were zero, with save completion and explicit
  game quit observed. The harness explicitly handles its HTTP process shutdown;
  game stops remain unlimited and graceful.
- Health observations confirmed each tested start begins without a readiness
  marker, then becomes healthy with a root-owned mode-600 marker identifying a
  live game PID. WebRCON alone is not sufficient to establish readiness.
- Independent label-scoped cleanup confirmed **zero** remaining containers,
  networks, volumes or outer harnesses for both Rust runs. Factorio's earlier
  pass remains applicable: its tested image and all **30** image/module source
  files were unchanged.

Native Rust acceptance used public source bundle SHA-256
`b827fd1c7e18aa514035141212ad76c0782f7ed8d91c516c7840d53d11f1fbf0`.
Subsequent source changes only update this verification record. No human client
joined; player-list acceptance used real empty servers.

The registry image digests are intentionally required in production before any
backup/stop. Locally built images are enabled only by the acceptance harness;
no controller environment flag bypasses publication checks. No image or release
has been published as part of these preparation checks.

## Unreleased: single-host manager, October 20, 2026

Implemented and accepted on a Windows x86-64 host running Linux containers with
Docker Engine 29.8.2. Work used a separate checkout and Compose project. Existing
Factorio game, controller and panel start times/restart counts were unchanged.
No existing game data, accounts, configuration or running Compose services were
adopted or changed.

- Node 24 Linux suite: **169 passed, zero failed, one skipped** (Lua interpreter
  unavailable). All **12 Python image-runtime tests passed** in Linux. Both
  launcher syntax checks and the separate Compose configuration passed. The
  Windows fleet launcher built and started a fresh host manager successfully.
- A disposable loopback-only fleet created two independent Factorio servers and
  two independent Rust servers, with unique volumes, bridges, ports and secrets.
  Game and controller resource limits were applied; memory-budget rejection,
  foreign-resource refusals and partial creation recovery are unit tested.
- Factorio 2.0.77 generated seed 786420, published a hash-verified snapshot, and
  loaded a clone with the same seed and fresh credentials. Editing clone settings
  left the source settings and readiness unchanged. Real named-volume map preview
  rendered successfully. Map export completed against an isolated copy; the fresh,
  unvisited world had zero explored chunks. No claim of populated-map rendering
  or multiplayer client joining is made by this acceptance.
- Rust installed through the reviewed didstopia digest, reached WebRCON readiness,
  saved/stopped/archived/resumed, and published a 24-file, 2,539,291-byte snapshot.
  Manifest SHA-256:
  `0f2194b3c0e92f4b5e2adb73a6bb3880a6d1614ceff1680266401895ab18a28b`.
  A second real Rust server loaded `proceduralmap.1000.572911.289.sav` from that
  snapshot. Both games reported seed 572911 and size 1000 through WebRCON. The
  clone used new credentials and server configuration. File sizes/hashes were
  independently recomputed and `cfg` was absent from the shared snapshot.
- Replacing the host manager reconnected its registered private bridges. All
  three then-running test game start times and restart counts stayed unchanged;
  scoped status remained reachable. Interrupted host jobs preserve data and mark
  themselves interrupted. Stopped-instance removal can be retried after a manager
  replacement without requiring an already absent network attachment.
- Real browser checks covered sign-in, game-specific creation options, the shared
  snapshot library, a scoped Factorio page, and scoped Rust/player controls.
  HTTP tests enforce shared-session, admin/viewer, CSRF and actor boundaries.
  Draft/preset scope is per account and per managed server.
- Every test game was saved/stopped and removed through the panel. All five test
  data volumes and both snapshots remained, confirming retention after removal.
  The disposable fleet's containers, bridges and eight owned volumes were then
  removed explicitly; its temporary image tag was removed. Shared game images and
  the existing standalone deployment were retained. A separate, empty LAN manager
  was started for administrator registration; no persistent game was added.
- Source packaging includes the new host launcher files only in complete source
  bundles; historical updater ZIPs retain compatible root paths. Packages exclude
  private environment files, registration links, local acceptance data and worlds.
  Module imports, both archive formats and prepare-only setup are regression
  tested. CI installs the locked runtime dependency before tests.

Limits: trusted single-host amd64 use; global admin/read-only roles; no adoption,
retained-volume purge UI, or fleet-aware image updater. Rust's pinned bootstrap
still downloads Steam's public game build, so recovery across a future build
change requires separate compatibility validation. Network joins from another
PC/console and a full computer reboot were not exercised here. Restart policies
were inspected; the manager replacement was exercised without restarting games.
See [host manager setup and operation](FLEET.md).

## Historical standalone Lobby Goblin and Rust runtime checks, October 19–20, 2026

The repository was renamed to `jkenneydaniel/lobby-goblin`. Source branding,
interfaces, launchers, image metadata, package names and documentation use Lobby
Goblin. Historical update archives, workers, repository settings and published
Factorio image labels remain supported. At the time of these checks, source changes were local and unreleased;
the existing Factorio installation was not deployed or reconfigured.

- Node 24 suite: 159 passed, zero failed, one Linux-only ownership check skipped
  on macOS. The final Rust subset passed all 18 checks after connection reuse.
  Python image-wrapper tests: 12 passed.
  Both current and historical release packages were unpacked/imported in temporary
  folders. Default and generated standalone Compose configurations validate.
- A native ARM64 panel image built successfully, imported both game modules and
  included the locked `ws` dependency. The actual built image passed first-time
  setup and a safe repeated setup from the release ZIP with no network, Docker
  socket or running game.
  Browser checks covered the renamed Factorio fixture, Rust fixture, and the final
  Rust web image connected to the disposable runtime. Synthetic preview data are
  distinct from the actual runtime results below.
- The Mac runtime test used a new temporary installation, a random installation ID,
  dedicated containers/bridge/accounts/secrets/data/backups, loopback-only random
  host ports, an 8 GiB game memory limit and four game CPUs. Controller/RCON ports
  were private. No existing Factorio container, installation or world was used.
- Game image: `didstopia/rust-server@sha256:f935f9631e53ad1a235b446496716e1ae65a8d179a3b620abf38e29b9877f88e`.
  SteamCMD installed app 258550, build 25902425, changeset 167781, protocol
  2634.289.1, Unity 6000.3.15x1-13. The image digest pins the bootstrap;
  SteamCMD downloads the game separately.
- Real registration/sign-in, starting/unavailable status, resource samples,
  authenticated Docker logs and password filtering were observed. Running-state
  settings edits were refused. A backup attempted before WebRCON readiness failed
  without stopping/restarting the game or publishing an invalid archive.
- The runtime exposed and corrected image-command-line defaults overriding
  `server.cfg`, Unity's unusable `/dev/stdout` logfile default (use `-logfile -`),
  an obsolete `-load` flag, and readiness waiting after process exit/restart.
  The startup-exit regression is covered by a test.

The stock image's 32-bit SteamCMD crashed under ARM emulation. A disposable
64-bit SteamCMD installer completed, but Rust then aborted in Mono's
`tramp-amd64.c:641` under Rosetta. An experimental, per-container Box64 build
(commit `75ff158c4ca9fd72ed4094a376a56fd62e5701ce`) passed Mono startup, but
procedural generation stalled. A downloaded 1000m public terrain map reached
entity/navmesh/occlusion and Steam initialization; management readiness still
has not completed. These experiments changed only the disposable stack, without
changing Docker's global emulator or VM settings.

The disposable Mac containers and private bridge were removed. The experimental
emulator is not part of the distributed setup or a supported ARM solution.

### Native Windows Docker acceptance

- The connected Windows 11 host has native x86-64 Linux Docker Desktop, a
  31.29 GiB Docker VM and about 29.8 GiB available during preflight. The saved TCP
  Docker context was stale; testing used its connected Windows Codex chat.
- A source-only transfer (165 allowlisted files, 339,355 bytes) was verified
  against SHA-256 before extraction into a new temporary directory outside
  Factorio. Its SHA-256 was
  `41575c5c19bafabad33288957ed20edbe2e4805ba10d99c532399d34d5eeb75d`.
- The isolated installation ID is `5bce0a3e8ec46500121da47bd2714021`.
  It has separate Rust/controller/panel containers, accounts, credentials,
  bridge, game data and backups. Panel/game/query host ports are loopback-only
  63967/53682/53683; RCON and controller ports are private.
- Windows-side Compose reported the game bind source as a Windows path. Creating
  only the disposable game container through Linux-side Compose produced the
  expected `/run/desktop/mnt/host/c/...` path. Strict mount/image/label checks
  remained enabled. This test adaptation does not add a native Windows installer.
- The panel image built, SteamCMD installed Rust successfully, and the game
  reached `Server startup complete` with a new 1000m map. The runtime reported
  `server.seed` 921721; the disposable game had four CPUs and a 12 GiB memory cap.
  Its Steam appmanifest confirmed app 258550, build 25902425; the loaded save was
  `proceduralmap.1000.921721.289.sav`.
  Controller resource readings, actual browser registration/sign-in and disabled
  running-state settings controls were observed.
- After a temporary host disconnect and renewed direct authorization in the
  Windows chat, testing resumed. The original WebRCON client left five sockets
  open, exhausting Rust's default five-connections-per-IP limit. Calls six and
  seven failed; a diagnostic client that explicitly terminated each socket passed
  all seven. Twenty paced calls passed after explicit cleanup, leaving zero
  sockets, but an unpaced ten-call burst hit Rust's reconnect controls and briefly
  made further calls unavailable. The final source fix uses locked `ws` 8.22.0
  and reuses one connection per controller, with correlated replies, up to 64
  pending commands and bounded upgrade time/payload size. Failure, timeout and
  30-second idle cleanup destroy the socket. Disconnected writes are never
  replayed. Loopback regressions cover stalled upgrades, unanswered closes,
  concurrent replies in reverse order, and timeout/disconnect recovery.
- The final controller passed 41 actual status/player requests across sequential
  and concurrent bursts and an idle reconnect, with no failures or controller
  restart. Exactly one connection remained after the bursts, zero after idle
  cleanup, and one after reconnect. Both runtime file hashes matched source.
- Clean save/stop exited with code zero and no OOM kill. All four exposed
  settings saved while stopped, preserving an unrelated setting. Start reached
  readiness. The exact patched runtime files were verified by SHA-256 before
  rebuilding only the disposable controller and panel. The source-transfer
  service on the Mac was closed after the verified initial download.

- The final patched runtime passed clean stop, settings save, start and restart.
  Running settings edits were refused. The real game reported the edited name
  and seven-player limit; an unmanaged configuration line remained unchanged.
- A real backup saved/stopped the game, published and verified an archive, and
  resumed to WebRCON readiness. Its authenticated download matched the stored
  archive: 2,390,224 bytes, SHA-256
  `f5cd229cd1d17cac73612f7a34a0d1ae1fc80e8fa46a6a0d5a759a3082a1dd8e`.
  Independent Python standard-library TAR extraction checked exact manifest
  membership and all 30 file hashes, totaling 4,302,477 uncompressed bytes.
- The disposable world was then changed and saved at 18.5, cleanly stopped, and
  its post-backup identity preserved separately. Only that disposable identity
  was replaced with the independently extracted copy. The module's start job
  succeeded, Rust reported the expected hostname and seven-player limit, and
  `env.time` returned **13.37243**, near the saved **13.37** marker. This is actual
  game-load recovery, beyond archive integrity. Logs confirmed **819 entities
  loaded from the save** and `Server startup complete`. The browser displayed the
  recovered server, empty player list, filtered logs, settings and verified backups.
  No human client join was tested.

Runtime acceptance passed. All three Windows test containers, their private
network and test panel/helper image tags were removed; checks found no remaining
owned containers or network. Shared bootstrap images and build cache were
retained. The redacted evidence report scanned 69 files against four test
secrets without finding a leak. The Mac disposable containers/network and local
UI preview processes were also removed/stopped. No running Factorio server,
existing installation or world was changed.

## Initial isolated Rust fixture checks, October 19, 2026

- Node 24.19.0 suite: 154 passed, zero failed, one platform-specific ownership
  check skipped on macOS. Existing Factorio regression tests still pass.
- Rust fixtures cover explicit module selection, storage markers checked before
  state writes, container/image/mount ownership, lifecycle/save failures,
  readiness, player privacy, filtered logs, settings preservation/injection and
  stale revisions, backup interruption consent, full identity inventory, archive
  corruption, failure resumption and retention. A sparse 513 MiB world fixture
  confirms streaming beyond the existing Factorio ZIP limit; system TAR lists
  generated archives independently. A loopback WebSocket server tests the native
  WebRCON client and request correlation; web tests verify admin/viewer and CSRF
  restrictions through the actual proxy.
- Both release formats include/import the Rust module, template and frontend.
  Prepare-only setup creates separate temporary installations and refuses an
  existing destination or a destination inside the Factorio checkout. The
  generated standalone Compose configuration validates with Docker configured
  to a nonexistent socket; no engine is needed or contacted.
- Browser acceptance used the disposable Rust UI fixture with real web,
  controller, account and archive code plus synthetic game/host transports.
  Inspected the rendered desktop panel and exercised sign-in, players, logs,
  confirmed stop/start, settings save and backup creation/verification. Confirmed
  the backup list and completion feedback refresh when a job finishes.
- At this initial fixture-only stage, no real Rust image pull/build/start, Docker
  engine action, installation or live recovery was performed. The later runtime
  attempts and remaining acceptance gap are recorded above. The
  running Factorio installation and existing worlds were not accessed or changed.
  See [Rust operation and limitations](RUST.md).

## Unreleased: shared core and Factorio module, October 19, 2026

- The complete Node suite passed on Node 24.19.0: 139 passed, zero failed,
  one platform-specific ownership check skipped on macOS. Existing integration
  fixtures still exercise Factorio lifecycle, world generation/switch recovery,
  backups, maps, tracking consent, accounts, drafts and updates with mock Docker.
- A different test-only game runs through the shared controller and web service:
  module-specific routes/assets/cookies, administrator/viewer/CSRF enforcement,
  operation locking, failed-job recovery and a non-Factorio backup layout.
- A Factorio module fixture supplies its own transport and custom paths/container
  name, verifies the legacy status/save commands and readiness fields, and blocks
  accidental fallback to the real Docker socket.
- Both compatible and complete source bundles are generated in temporary folders
  and accepted by the existing updater package validation. An image-layout check
  follows the Dockerfile's local COPY rules and imports the packaged runtime.
  Prepare-only setup and a repeated setup preserve temporary private state and
  create no world saves. The built-image smoke check now compares nested core and
  game sources as well as the original runtime files.
- No Docker image build, deployment, engine/host operation, live panel acceptance
  or real game-load test was performed for this refactor. Tests use temporary
  data, fake host launchers and mock transports; the running installation and
  existing worlds were not accessed or changed. Compose, environment defaults,
  public URLs, persistent paths/formats and updater/state contract versions are
  unchanged. See [architecture and compatibility](ARCHITECTURE.md).

## v0.2.6-alpha: release preparation, October 19, 2026

- Packages the enemy-map fix and measured panel/image-source performance work
  described below. Panel versions, Compose defaults, build labels and release
  workflows are aligned to `0.2.6-alpha`. The game image selection and Factorio
  version remain unchanged; revision `2.0.77-fc.2` is source-only and unpublished.
- The release-version Node suite passed 137 tests with one Linux-only ownership
  check skipped on macOS. All 12 Python runtime tests passed, default Compose
  configuration validated, and both source/update bundles passed packaging checks.
  Hosted build/package results are verified separately during publication.
- Release preparation and publication do not deploy the panel, publish the game
  image, refresh an installed map or access existing worlds.

## Unreleased: enemies on saved maps, October 19, 2026

- Confirmed the previous exporter included spawners/worms but omitted enemy
  units. Its first-come 80,000-object cap could omit later bases after resources
  filled the array. The renderer gave zoomed-out bases only two-pixel markers.
  This source investigation did not inspect the user's active snapshot, so it
  does not establish which condition affected that particular map.
- Added enemy units, cap priority for enemies and additional priority for bases
  and worms over unit swarms. Kept the existing object/chunk/size limits and
  explored-area filter. Added red diamond/circle/dot markers above other objects,
  a minimum marker size, enemy inspection and saved-position guidance. Existing
  format-1 snapshots remain readable; new exports mark support for enemy units.
- Lua fixtures run the production scripts against charted/uncharted chunks,
  boundary overlap, neutral units, full resource/building/unit arrays and an
  all-base array. They verify deduplication, preservation priority and the hard
  cap. Node renderer tests verify marker geometry, draw order, selection above
  resources and the layer toggle. Lua fixtures require a local Lua interpreter;
  that test explicitly skips when the interpreter is unavailable.
- A disposable Factorio 2.0.77 container created a new world and five real enemy
  entities: biter/spitter spawners, a worm, a biter and a spitter. Production batch
  export retained all five both normally and with 80,000 prefilled resource
  entries. This runtime check used an explicitly queued fixture chunk; it did
  not claim that the generated world had player exploration. The chart filter
  is covered separately by the Lua fixture and is unchanged.
- The runtime report is under ignored
  `output/implementation/map-enemies/fc-map-enemies-2985143b-cea2-4e9b-b877-11cb9da4539c/`.
  The image was the existing owned `2.0.77-fc.1` through this Mac's amd64
  compatibility runtime. The report confirms private container/volume cleanup.
- Playwright checked a loopback-only synthetic panel fixture with no controller
  or Docker access, including an overlapping base/resource, marker pixels,
  checkbox removal, inspection and desktop/mobile screenshots. Evidence is in
  ignored `output/playwright/map-enemies/`. The only failed resource was the
  preview fixture's missing favicon; no application exception was observed.
- Full Node suite: 137 passed, one Linux-only ownership check skipped on macOS.
  No deployment, commit, publication, active-server commands, existing-world
  access or installed-map refresh was performed.

## Unreleased: normal-startup saving comparison, October 17, 2026

- Ran 12 disposable trials through the normal image entrypoints: three ordinary
  and three non-blocking-save trials each for Lobby Goblin `2.0.77-fc.1` and
  Factorio Tools `2.0.77`, using the same generated save and identical RCON client.
- Each image completed nine ordinary saves and stayed responsive. Both images
  crashed in all three non-blocking-save trials after the first child save, with
  the same `poll failed: Interrupted system call` error and exit status 1.
- Confirmed identical Factorio executable hashes. Normal Lobby Goblin ran
  Factorio as PID 1; Factorio Tools used its normal `runuser` wrapper. The failure
  is not unique to our image or dependent on the previous Python-parent layout.
- All runs used local amd64 images through OrbStack compatibility on this Mac.
  Native x86 behavior and the precise underlying cause remain unverified.
- Captured full trial logs, fixture/client hashes, state and cleanup in the
  [performance report](PERFORMANCE.md#normal-startup-saving-follow-up). All private
  containers and volumes were removed. No running server, installation data or
  existing worlds were accessed, and no runtime configuration was changed.

## Unreleased: isolated server performance, October 17, 2026

- Benchmarked the existing amd64 image with private generated data. The
  confirmation run and measurement limits are recorded in
  [PERFORMANCE.md](PERFORMANCE.md): ownership scans were 62.8% faster on the
  volume and 59.1% faster on the bind mount; warm status command cycles were
  49.4% shorter; lower-priority exports reduced game update time by 17.4% under
  forced CPU contention. These are component timings on this host, not live
  multiplayer or whole-application performance claims.
- Implemented the measured ownership, metadata cache and export-priority changes.
  Left storage and saving configuration unchanged. Non-blocking saves crashed
  the disposable parent process on this runtime; the completed child save did
  not establish a usable performance result.
- Built image revision `2.0.77-fc.2` locally and passed the full isolated container
  acceptance suite, including preservation of legacy fixture data, save/stop,
  old-binary reload, direct creation and PNG preview. Its local image ID is
  `sha256:ff99fd13512ae77fa88cb8bd0a5d455f6d2c6e124cf1139bc9dda3f0156174a6`.
- The full Node suite passed 135 tests with one Linux-only ownership check
  skipped on macOS. All 12 Python runtime tests passed. Controller integration
  verifies live player/time queries, cached seed/version and restart invalidation.
- All benchmark containers and volumes were removed. No installed stack,
  existing worlds, live-server commands, ARM tuning, publication or deployment
  were used. The new image revision and panel changes remain local.

## v0.2.5-alpha: world-creation preview performance, October 17, 2026

- Matched Factorio's preview generator to the existing one-CPU quota with
  `--threads 1`. Kept 1024 pixels, one meter per pixel, the installed image,
  isolated mod copy, network isolation, one-GB cap and render queue unchanged.
- Started the initial preview immediately; later edits still debounce for
  900 ms. Rendering polls now run every 250 ms; queued polls stay at 900 ms.
- Compared the existing default threading and one explicit thread using two
  disposable container runs each, with the same seed 123456789, default terrain,
  image 2.0.77-fc.1 and one-CPU cap on this ARM Mac's amd64 compatibility runtime.
  Average Factorio process time was 4.788 s versus 3.555 s
  (25.7% lower). All PNG SHA-256 hashes were identical. These are local
  unmodded measurements, excluding Docker launch/mod-copy/browser overhead, not
  a timing guarantee for another host or mod pack.
- A two-CPU/two-thread experiment averaged 2.496 s with identical PNGs;
  the product continues to use one CPU to retain its existing resource budget.
- In separate loopback-only browser fixtures with a synthetic 150 ms renderer,
  the initial POST arrived at 978 ms before and 73 ms after; image requests
  arrived at 2412 ms and 334 ms respectively. These verify browser waiting only,
  not the speed of real map generation. Fixtures had no Docker/controller access.
- The 23 focused preview/integration tests passed, including cache/queue behavior,
  account isolation, expiry, validation, unchanged save-library contents, no
  active-game Lua and worker cleanup. The helper regression assertions verify
  one thread, the original 1024 pixels, one CPU, one GB and no network.
- Release preparation passed the full local suite: 128 tests passed, with one
  Linux-only ownership check skipped on macOS. Default Compose validation and
  source packaging passed; 112 allowlisted files were included without runtime data.
- No running server, existing worlds, deployment or image publication was used.


## v0.2.4-alpha: first-install acceptance checks

- Setup now verifies a parseable system CA bundle and functioning Docker, Compose
  and Buildx clients before creating private installation data. These checks run
  without network or a Docker socket; unit tests cover absent/corrupt bundles and
  missing plugins with actionable setup failures.
- Built a separate image and packaged 100 allowlisted source files. The image
  smoke test validates the actual ZIP/checksum/installer metadata, compares its
  application files to the image, performs first-time setup, then reruns setup.
  Configuration, account state, controller credentials and the original invitation
  stayed byte-for-byte unchanged. The source baseline verified and no world or game
  container was created.
- Injected an empty CA bundle into the otherwise working image. The real setup
  command refused it before writing any installation directory.
- 123 application tests passed in isolated Linux fixtures. The running game and
  panel services were not replaced for these acceptance checks.
- Both CI and release packaging now include the smoke test; release packaging
  also repeats the fresh-registry/restricted-build check before attaching ZIPs.
  These workflow additions are locally verified and await a GitHub run. They
  protect new installers once included in a newly published release.

## v0.2.4-alpha: updater build certificates and diagnostics

- Docker Desktop's retained engine logs identified the failed v0.2.1-to-v0.2.3
  build: Docker Hub token requests failed with an unknown certificate authority.
  The released panel image had no `/etc/ssl/certs/ca-certificates.crt`.
- A fresh `docker manifest inspect` reproduced the TLS failure from the released
  image. The fixed image includes the Docker CLI stage's 181,724-byte CA bundle;
  the same request succeeds with certificate verification enabled.
- A real `docker build --pull` succeeded through the Docker socket using the
  worker's read-only root, dropped capabilities, restricted additions, memory
  limit and temporary filesystem. A normal cached build also succeeded without
  the fix, confirming that cached metadata alone is not a useful TLS check.
- 120 application tests passed in an isolated Linux container, including new
  timeout, output-limit, redaction and persisted-build-failure regressions.
  Windows host-launcher checks passed separately (5 passed, 1 Linux-only skip).
  The fixture suite uses no production Docker socket, saves or accounts.
- CI now repeats a fresh registry request and nested build from the restricted
  image. This new CI step is locally verified; it has not run on GitHub yet.
- The local fixed panel/controller image was deployed after a verified world
  backup. Both services became healthy; the Factorio container was not replaced
  or restarted. This local fix has not been published as a new GitHub release.

## v0.2.3-alpha: manual release checks

- Reproduced the missing review action on a panel with a cached current-release
  result. Verified that the released 0.2.1-alpha checker detects 0.2.2-alpha on a
  fresh public GitHub request; automatic results remain cached for six hours.
- In an isolated loopback preview with installation disabled and no Docker
  access, Check for updates fetched the published release and revealed Review
  panel update without navigation. Opened and cancelled both the panel review
  and the same-version Lobby Goblin image review; no install jobs were made.
- Retrieved the published 2.0.77-fc.1 image manifest/configuration anonymously and
  validated its amd64 metadata with the panel compatibility validator. No image
  was pulled or installed, and no game binary was started.
- Regression coverage checks manual-cache bypass, one-minute limiting, request
  coalescing, disabled checks, administrator/CSRF requirements and a stale
  controller cache during panel review.


## v0.2.2-alpha release compatibility follow-up

The initial hosted image check found that the Linux runner's classic Docker CLI
has no `image inspect --platform` option. Inspection now accepts an already
resolved amd64 configuration from the normal inspect result, requesting explicit
platform selection only for multi-platform/index results. The panel continues to
reject mismatched architecture, compatibility metadata and missing registry digests.

Classic stores also omit registry digests for an unpublished local build. The
image acceptance runner validates that build's metadata and probes its immutable
local ID; this exception is confined to build-time testing. Installing through the
panel always requires a verified repository digest. Regression tests cover both
store types and the existing rejection cases. The complete local Node suite
passed 120 of 121 tests with one platform-specific skip, and the revised real
container acceptance sequence passed again with disposable resources.

## v0.2.4-alpha: isolated image build and container acceptance, October 16, 2026

Built `ghcr.io/jkenneydaniel/factorio-server:2.0.77-fc.1` locally with OrbStack
on an ARM Mac, targeting `linux/amd64` and executing with x86 compatibility.
The local repository digest is
`sha256:c8056ca33a857406bd1f75521f237782faa810f4bf76e05d21d4d827e0dba990`;
the amd64 manifest is
`sha256:2d6a54133f18cd864bacbc56ffe052e141fab7dbac81660151d7692e3f43bcfb`.
The Docker build verified the official archive checksum and the actual binary's
2.0.77 version. No Factorio Tools layer was used to build the owned image.

Real container acceptance passed:

- Both image sources passed the panel's shared read-only, unprivileged binary
  and tool preflight using verified repository digest references.
- A save created by the legacy image loaded in the owned image, exposed RCON
  and returned the expected version and a numeric game tick.
- RCON save and SIGTERM shutdown completed with exit code zero. Settings, mod
  selections and the RCON password retained their original SHA-256 checksums.
- The legacy binary reloaded the save written by the owned image successfully.
- Direct worker-style world creation produced a valid ZIP with `level.dat0`,
  and map generation produced a verified 128 × 128 PNG.

The real run identified and fixed explicit platform selection during image
inspection, the plain RCON version response and use of a runnable repository
digest instead of a platform-specific inspect identifier. Regression coverage
also reflects the fresh-save Lua achievement prompt and actual save format.
The full Node suite passed **119 of 120 tests with one platform-specific skip**;
all **10 Python tests** passed. After the final preflight integration, all 21
affected image/update tests and the real acceptance sequence passed again.

Only UUID-named test resources and disposable data were used. There were no host
bind mounts, published ports, Compose operations or container network access.
All test containers and volumes were removed; all 13 pre-existing local
containers retained their identities, images, start times and running states.
The running Factorio installation, existing worlds and installation `.env` were
not accessed. Local logs and image/cleanup evidence are retained under
`output/implementation/game-images/container-acceptance.{log,json}`.

The image remains local and unpublished. No deployment or live image migration
was performed. This run does not establish native ARM support or acceptance on
an independent x86 Linux host.

## v0.2.4-alpha: independent Factorio image and image-source selection

Validated locally on macOS with Node 24.21.0 and Python 3.14.5: **119 Node
tests, 118 passed and one Linux-root ownership test skipped; 10 Python tests
passed**. Tests use temporary files, simulated Docker calls and fake RCON
sockets. They cover same-version source changes, pinned image identities,
architecture and compatibility rejection, recovery, existing settings/save
preservation, fresh-install behavior and multipart RCON responses.

The official 2.0.77 headless archive checksum and Debian amd64 base digest were
verified against their public sources. The owned image uses these directly and
does not derive from Factorio Tools. It targets Linux x86-64 only.

A temporary release package was accepted by the existing HEAD updater using the
compatibility ZIP, and by the new updater using the complete source ZIP. Panel
update tests also passed from the extracted compatibility package. Packaging did
not include private/runtime data or change existing release artifacts.

Browser acceptance used only the synthetic loopback fixture on port 8097:
selected the owned source, reviewed its exact same-version image tag, cancelled
the review, checked downgrade rejection and inspected desktop and 390 × 844
phone layouts. Screenshots are under `output/implementation/game-images/`.

At this initial implementation stage, the separate image workflow was prepared
to build and test disposable volumes,
legacy-save loading, RCON, graceful save/stop, legacy reload, world creation and
map preview before optional publication. The subsequent Docker build and container
acceptance are recorded above. Nothing was published or deployed; during this
initial implementation stage the
real Docker socket, running server, worlds, settings and installation `.env`
were not accessed or changed.

## v0.2.4-alpha: configurable backup cleanup

Validated locally on macOS with Node 24.21.0: **106 tests, 105 passed and one
Linux-root ownership test skipped**. Cleanup tests use temporary archives;
integration tests use a mock Docker API and confirm cleanup sends zero Docker
mutations while preserving the original save and running-state fixture.

Coverage includes bounded age windows, cutoff equality, category opt-in, newest
copies, current verified archives, pending update recovery, unknown archives,
symlinks, file replacement, expired/replayed reviews, partial deletion failures,
policy persistence, concurrent settings revisions and the daily due clock.
Scheduled count pruning now shares the same protections and operation lock.

Browser acceptance used only the loopback fixture on port 8096: reviewed exact
candidates and protected reasons, changed the window to an empty review, opted
manual/pre-change copies in, confirmed a simulated daily policy, saved a manual
window using Enter, reloaded it, and completed a memory-only cleanup from 16 to
7 synthetic archives. Reviewed the default desktop viewport and 390 × 844 phone
layout, including 44px checkbox-label targets and no page overflow. Screenshots
are under `output/implementation/backup-retention/` (local evidence only).

No real backups, running server, world saves, Docker socket or deployed panel
were accessed or changed. Automatic cleanup remains off by default. This is
local implementation and isolated validation, not deployment or live acceptance.

## v0.2.4-alpha: guided diagnostics, saved presets and persistent drafts

Validated locally with Node 24.21.0 on macOS. The complete suite has **92 tests:
91 passed, one Linux-root ownership test skipped**. New coverage exercises:

- Authenticated diagnostics with an unreachable controller; partial Docker,
  storage, architecture and readiness failures; Windows-container guidance.
- Read-only probes and a report allowlist excluding raw Docker details, error
  messages, paths and credentials.
- Private per-account setup persistence across restarts/password changes and
  cleanup on account deletion; administrator-only API access and CSRF checks.
- Revision conflicts, stale draft deletion, preset limits/validation and exact
  preservation of unfinished input without restoring activation.

Browser acceptance used only the synthetic loopback UI fixture. Confirmed preset
save/load, draft recovery of unfinished JSON after reload, blocked review before
applying it, cross-tab conflict rejection, switching unchecked after reload,
simulated successful creation clearing its submitted draft, and support-report
JSON download. Reviewed desktop (1486 × 1059) and phone (390 × 844) layouts.
Screenshots are under `output/implementation/diagnostics-presets/` (local evidence,
not included in releases). Fixture map artwork is synthetic.

No real Docker socket, running game, world save, live account or deployed panel
was accessed or changed for this feature work. This records local implementation
and isolated validation, not deployment or live server acceptance.

## CI follow-up: wait for completed jobs to release their operation lock

The first v0.2.1-alpha tag CI run failed when the integration fixture submitted
restore and console actions while the controller was still finishing a prior
job. `setJob` exposes the terminal result before its asynchronous persistence
finishes; the operation lock is released in `finally`. The fixture incorrectly
treated the terminal result alone as permission to submit its next operation.
The controller's HTTP 409 refusal during this interval is expected serialization.

Sequential fixture actions now require both a terminal result and an idle
controller. Requests still assert HTTP 202 immediately; the fixture does not retry
rejected mutations or relax controller protections. Three deterministic tests
cover terminal-state persistence, another active operation, failure completion
and bounded timeout. All three fail with the original terminal-only predicate.

On macOS with Node 24.21.0, the full suite passed 81 tests with one Linux-only
ownership skip (82 total), and 20 consecutive integration runs passed. All
operations used temporary files and simulated Docker. The original tag CI rerun
also passed. That rerun uses the original tagged source; it confirms the earlier
failure was intermittent, while the durable fixture fix lives in the subsequent
main-branch commit. The published tag and release assets were not changed, and
no running server, container or save was touched.

## v0.2.1-alpha: combined release and controller CPU fix

On October 16, 2026, the published v0.2.0-alpha source was merged with the local
controller improvement. All 79 tests passed in Node 24 Docker as root, including
the Linux ownership test, host-launcher simulations, updater recovery, automatic
save-triggered map refresh and the three snapshot-metadata regression tests.

The cache parses the map only when its file identity, size or timestamps change.
It retains only world, source version and creation time, and also serves the
lightweight map-status endpoint. Tests cover concurrent readers, equal-size file
replacement, replacement during parsing, deletion/recreation, invalid JSON and
filesystem errors. Automatic refresh after completed saves remains enabled.

The original controller investigation used a 23 MB saved-map snapshot. Matched
20-second samples fell from 10.8% average controller CPU to 1.5% after applying
the local fix (about 86% lower in that sample). This is a short local measurement,
not a performance guarantee for other worlds or hosts.

Both default and private local Compose configurations validated. The combined
alpha image was built separately; no running game or panel service was replaced
during this merge/release preparation. The local controller image override stays
private, and the source ZIP includes the cache implementation and its tests.

## Local follow-up: host setup, in-panel updates and panel redesign

The v0.2.0-alpha changes were checked on an Apple Silicon Mac using
Node 24.21.0. No Docker container was started, rebuilt or replaced for this work.

- 75 automated checks passed; one root-only Linux ownership check was skipped.
  Host launchers use a simulated Docker executable, covering prepare-only,
  explicit start, import paths with spaces, configuration preservation, native
  Linux socket-group selection, remote/rootless rejection and failure handling.
- Mock Docker integration checks assert amd64 platform selection and reuse of the
  installed game image ID for generation/preview helpers. Existing world/map,
  authentication, backup/restore and recovery checks also pass.
- Release-check tests cover semantic/prerelease ordering, stable/preview channels,
  request coalescing, six-hour caching, ETags, offline/rate-limit behavior and
  administrator-only access. Install endpoints require a reviewed plan, explicit
  confirmation, same-origin/CSRF checks and administrator access.
- Temporary installation fixtures exercise staged source installation, local-edit
  refusal, ZIP/checksum/state-contract rejection, backup failure, expired reviews,
  detached-worker launch, panel recovery after failed health checks, pinned amd64
  game upgrades, failed downloads, game readiness failure and explicit restore
  handling. Docker/Compose calls are simulated; these are not live lifecycle tests.
- A read-only public GitHub query through the new checker identified the current
  repository release as v0.1.0-alpha. It downloaded no release assets.
- Compose configuration and shell syntax validated. An isolated browser fixture
  demonstrated update controls and a game-upgrade review using synthetic versions.
  The review was cancelled; the fixture rejects every installation request and
  has no Docker socket or real account/save access.
- The Dockerfile now includes the official Docker CLI/Compose/Buildx for update
  workers. This revised image has not been built or run locally. Release metadata
  is included in the source package; hosted build results are recorded on GitHub.
- Mac/Linux/Windows host-launcher CI jobs exercise simulated Docker only.
  PowerShell execution, independent Linux hosts and game emulation on ARM were
  not validated locally. Configuration support is not runtime proof.

- The release ZIP preserves executable Unix launcher permissions, including the
  Mac Finder shortcut. A regression checks the ZIP metadata.
- Onboarding tests cover owner-only first-run state, legacy-account behavior,
  restart persistence, admin/CSRF checks, readiness rejection and persisted
  completion after a confirmed save. Finishing a job clears cached status so
  first-save readiness appears immediately.
- Browser acceptance used loopback-only synthetic fixtures without Docker access.
  Checked every main route at desktop and phone widths, creation at 1024 × 768,
  tab keyboard navigation, hidden-field validation, retained edits, changed-setting
  review, simulated library creation, waiting/ready onboarding and completion,
  registration layout, read-only controls and update review/cancellation.
- Desktop references and actual browser captures were compared for typography,
  spacing, colors, icons, copy and responsive behavior. Captures are local review
  assets under `output/implementation/`; root `design-qa.md` records the comparison.
  Synthetic map imagery is not a real seed render. No real world was created or
  switched and no update was installed. Main-preview console warnings/errors were
  empty at the final browser check.

## Original alpha checks

Verified on Windows Docker Desktop with Linux containers on October 15, 2026.
The release was prepared alongside an existing installation without deploying
to it. The original game, controller and web containers retained their start times.

- 51 automated tests passed in Node 24 Docker, including authentication,
  invitations, role restrictions, CSRF/origin checks, ZIP validation, backup/restore,
  failed world-switch rollback, maps, preview scheduling and world constraints.
- Setup tests cover fresh installation, idempotence, recovery, save import,
  corrupted imports, existing-world protection, incomplete state and symlink
  refusal. A root-run Linux container test verifies new file UIDs and secret modes.
- Both default and existing local Compose configurations validated. The alpha
  image built separately from the running installation's image.
- A disposable Compose stack used independent data, unique names and loopback
  ports. Fresh game generation, web health, private registration, recovery and
  consumed-link rejection succeeded.
- The disposable stack rendered a real Factorio terrain PNG and generated a
  custom world from the compact preset with engine-supplied advanced defaults.
  Its active world was preserved.
- Import copied that disposable world's ZIP byte-for-byte. A network-isolated
  game container loaded the imported world and reported the expected seed.
- The source packager excludes runtime/private data and emits a source directory,
  ZIP, SHA-256 checksum and per-file manifest. Publication safeguards were checked
  against a deliberately invalid fixture before final packaging.

The temporary game/management containers were removed afterward. These checks
do not verify an independent Linux host, ARM, rootless Docker, Internet hosting,
GitHub-hosted workflow execution or an independent security audit. No real user
save or account is included in a test fixture or source artifact.

## Repository organization — October 22, 2026

This source-only change groups both image builds under `images/`, moves host
helpers under `scripts/`, places the fleet template under `deploy/fleet/`, and
consolidates installation/documentation entrypoints. Root standalone Compose and
Rust's runtime Compose template retain their existing paths. Release packaging
maps organized sources back to historical installed paths.

Local validation used Node 24.21.0 and the existing locked dependencies:

- `npm test --prefix panel`: 267 passed, zero failures, one Lua/platform skip.
- `node --test panel/applications/factorio/images/test-build.mjs`: four passed, with simulated Docker.
- `python3 -B panel/applications/factorio/images/test_runtime.py`: 20 passed.
- The release fixture validates the compatible ZIP with frozen v0.2.0-alpha and
  v0.3.3-alpha updater code, extracts both bundle types, checks both bundles'
  documentation links, exercises packaged setup/image fixtures, and repackages
  the extracted complete source bundle in temporary directories.
- Relocated launcher fixtures verify repository-root state paths using a fake
  Docker executable. Shell syntax and source documentation links also passed.
- All 231 pre-existing source files were accounted for after relocation. Existing
  game/bootstrap source, manifests, dependency lockfile and default Compose
  content were retained; a source snapshot was saved outside the repository.

No Docker daemon, live game storage, running server, deployment, image build or
publication was used for this verification. Windows launcher runtime, hosted CI
and real container acceptance were not repeated by this source reorganization.
