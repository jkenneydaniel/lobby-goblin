# Workload support and capability matrix

Assessment: 2026-11-03, source baseline
`3b7469ba746c969ad8ac2ab99a3795f500f09738`. This records source capabilities and
their evidence; it is not a promise that an image is currently published or that
an existing installation has been upgraded. Recheck the target release, image
identity and acceptance records before changing a capability label.

## Evidence labels

- **Implemented:** registered source and a real execution/provider path exist.
  Scope is limited to the operations and environments its contract supports.
- **Fixture-proven:** disposable tests demonstrate the contract, using synthetic
  processes/transports where stated. They do not establish a production runtime.
- **Planned:** discovery or design work; no supported hosting option is implied.
- **Unverified:** the reviewed evidence does not establish the particular claim.
  A source definition, successful archive or healthy web endpoint is not proof
  of publication, native game readiness or complete application recovery.

## Registered workloads

The explicit [registry](../panel/applications/registry.json), package definitions
and [provider contract](APPLICATION_PACKAGES.md) determine current support.

| Workload | Implemented scope | Runtime and acceptance boundary |
| --- | --- | --- |
| Factorio | Game-aware lifecycle, worlds/saves, map previews, players, typed settings, mods, backups and reviewed software/image changes | Linux amd64 game images. Bundled baseline and runtime-delivery variants have distinct image/software identities. Preserve exact selected releases, save barriers, world formats and explicit upgrade/recovery consent. See [images](../panel/applications/factorio/images/README.md), [updates](UPDATES.md) and [verification](VERIFICATION.md). |
| Rust | Game-aware lifecycle, players/logs/settings, Carbon/Oxide/uMod workflows, backups, reviewed installation/change and recovery | Linux amd64 game/worker paths. Installed software, selected image and worker compatibility are separate identities. Old workers may be refused for management upgrade; a Steam heartbeat alone is not game readiness. See [Rust](RUST.md), [image/software guide](../panel/applications/rust/images/README.md) and [verification](VERIFICATION.md). |
| Status Page | Real single-container HTTP process, typed public settings, Docker health readiness, logs, shared accounts/operations and stopped-data snapshots/cloning | `managed-container-v1`, reviewed Linux amd64 image, one process and one data claim. Non-root UID/group policy, immutable image admission and bounded archives apply. [Package](../panel/applications/status-page/README.md), [definition](../panel/applications/status-page/definition.json), [historical native/broker evidence](verification/application-packages.md). |

The [panel/controller image](DEVELOPMENT.md#shared-runtime-publication) has
amd64/arm64 publication and smoke-test paths. That does not make each game or
application image native ARM64 software. ARM64 game operation requires the
documented amd64 emulation policy and its own acceptance. Source checks and
recorded disposable tests do not establish support on every host or deployment.

### Single-container application limits

The real [container provider](../panel/core/container-application.js) supplies
one image-owned process with a Docker health check, typed **non-secret** JSON
settings, stopped-state configuration and explicit immutable image admission.
It refuses multiple services, private secret references and deployment tasks.

Backups require a definitively stopped process; the provider does not stop it
automatically. Data is limited to 4,096 files and 64 MiB, with a separate 65 MiB
complete-ZIP limit. Metadata traversal is bounded before content reads; links
and unsafe paths are rejected. Recovery clones into a fresh instance with fresh
controller credentials, rather than providing in-place restore. These bounds
are not suitable defaults for arbitrary game worlds or database applications.
See the full [package contract](APPLICATION_PACKAGES.md#existing-providers).

Status Page has recorded native provisioning, readiness, settings, backup/clone
and broker-isolation evidence. That historical proof is neither a new test run
for this document nor a claim that a public registry tag is available today.
The [package template](ADDING_AN_APPLICATION.md) is an unregistered example.
Status Page's HTTP content is public on its allocated workload port; panel
authorization protects editing, not that listener. It does not inherit the
panel's authentication or TLS. Public ingress remains a separate profile and
deployment decision.

## Contracts demonstrated by fixtures

| Contract | Evidence | What remains unproven |
| --- | --- | --- |
| Shared game/application presentation and permissions | Factorio/Rust packages, the synthetic Arena and non-game browser fixtures, [definitions](APPLICATION_DEFINITIONS.md) | Arena is not a registered production game. A synthetic page does not establish a new game binary or provider. |
| Web, queue and scheduler dependency/health coordination | [Service factory](../panel/core/service-application.js), [service tests](../panel/test/application-services.test.js), [synthetic definition](../panel/test/fixtures/service-app-definition.json) | Production multi-service Docker provisioning, real PHP execution and complete application health. |
| Private reference seams and deployment uncertainty | [Deployment contract](APPLICATION_DEFINITIONS.md#private-providers-and-deployment-recovery), [deployment tests](../panel/test/application-deployment.test.js) | A production secrets product, real migrations, ingress and database-consistent recovery. Unknown effects must not be replayed merely because a final artifact is absent. |

Laravel, Magento and Varnish are **planned**, not registered packages. A Laravel
web response would not prove worker/scheduler readiness, and a filesystem ZIP
would not prove database/media consistency. Declaring more services or secret
fields cannot grant production behavior that a provider explicitly refuses.

## Pterodactyl comparison

Comparison checked against official documentation on 2026-11-03. Use
**1.x stable** as the main baseline; **2.0 is open beta**. The 2.0 extension
marketplace is a separate emerging capability. [Official version status](https://docs.pterodactyl.io/v2).

This is an evidence-based gap inventory, not a commitment to copy every feature
or a claim that the two products share a tenant/security model.

| Area | Lobby Goblin evidence | Pterodactyl reference and remaining work |
| --- | --- | --- |
| Workload breadth | Three registered packages and reviewed provider boundaries | Broad [egg catalog](https://eggs.pterodactyl.io/). Qualify more built-ins; arbitrary executable egg/plugin imports are a separate trust decision. |
| Hosts/resources | [Remote hosts](REMOTE_HOSTS.md), [configured memory budgets](FLEET.md), existing broker resource fences | [Nodes](https://docs.pterodactyl.io/v1/api/application-nodes/post-create-node), [network allocations](https://docs.pterodactyl.io/v1/api/application-nodes-allocations/post-create-allocations), [build limits](https://docs.pterodactyl.io/v1/api/application-servers/patch-update-build). Audit CPU/disk/IO reporting and enforcement separately; memory allocation is not network allocation. |
| Delegation/history | [Server assignments, explicit mod/image grants and audit history](ACCESS.md) | [Subuser permissions](https://docs.pterodactyl.io/v1/api/client-general/get-show-permissions), [TOTP](https://docs.pterodactyl.io/v1/api/client-account/post-enable-2fa). No TOTP implementation was found in this source audit; authentication changes need their own design. |
| Files | Bounded game/archive/mod workflows | [File manager](https://docs.pterodactyl.io/v1/api/client-server-file-manager/get-upload-file), [SFTP keys](https://docs.pterodactyl.io/v1/api/client-account/post-create-ssh-key). No general user-facing file editor/SFTP service was found in the audited Lobby source. Do not infer arbitrary file access from archive/mod access. |
| Backups | Game-aware archives, verification, retention and bounded single-container snapshots | [Local/S3 storage](https://docs.pterodactyl.io/v1/panel/additional-configuration). Off-host storage and database-aware recovery remain discovery/design work. |
| Scheduling | Backup schedules and game-specific coordination | [Cron-style schedules](https://docs.pterodactyl.io/v1/api/client-server-schedules/post-create-schedule) and [ordered tasks](https://docs.pterodactyl.io/v1/api/client-server-schedules/post-create-task). General scheduling must not silently introduce arbitrary shell execution. |
| Integrations | Session/CSRF-protected product endpoints and shared operation contracts | Separate [Client and Application APIs](https://docs.pterodactyl.io/v1/api). A supported external credential/API-key product, scopes and revocation would need a distinct proposal. |

Absence claims are scoped to this repository audit. Partial controls are not
complete quota, API or scheduling parity. Pterodactyl's ordinary egg/server unit
does not by itself prove coordinated Laravel/Magento application releases and
recovery; that capability remains unverified here. Its Panel being built with
Laravel is not proof of a Laravel workload adapter.

## Expansion sequence and qualification

The lead maintains the backlog in [issue #77](https://github.com/jkenneydaniel/lobby-goblin/issues/77).
These priorities follow current engineering evidence, not measured demand.

| Priority | Proposed work | Acceptance before a support claim |
| --- | --- | --- |
| First | One additional game; Minecraft Java qualification study, then Valheim | Official distribution/terms and exact game/JRE/image identities; explicit operator acknowledgements; version-aware readiness, graceful save/stop, restart, complete backup/clone and interrupted recovery; negative ownership/scope tests. No binaries or native servers were run for this matrix. |
| Foundation | Production multi-service provider design | Per-service storage/configuration and private references, resource/network boundaries, dependency readiness, partial-start recovery and durable uncertain effects. A failed required worker must prevent whole-stack health. Return concrete sensitive implementation scopes before executing them. |
| First application pilot | Fixed-version disposable Laravel sample | Web, queue and scheduler lifecycle, correct public root, writable storage, cache generation, worker reload, scheduling coordination, chosen database/cache and migration/recovery evidence. [Deployment](https://laravel.com/framework/docs/13.x/deployment), [queues](https://laravel.com/framework/docs/13.x/queues), [scheduler](https://laravel.com/framework/docs/13.x/scheduling). |
| Alongside foundations | Bounded Varnish profile | Exact distribution/version, declared origin, generated/validated policy, origin-failure behavior, private-response handling, cache bounds and unauthorized purge rejection. Arbitrary VCL/VMODs are outside the initial profile. [Distribution](https://www.varnish.org/), [VCL](https://www.varnish.org/docs/reference/vcl/), [purge](https://www.varnish.org/docs/tutorials/purge/). |
| After recovery foundations | Magento Open Source or Adobe Commerce, with an explicit edition/version | Official dependency matrix; database/media backup and recovery; search readiness, cron/indexer/consumer observations and a disposable end-to-end journey. No customer/payment data or production traffic. [Requirements](https://experienceleague.adobe.com/en/docs/commerce-operations/installation-guide/system-requirements), [cron](https://experienceleague.adobe.com/en/docs/commerce-operations/configuration-guide/cli/configure-cron-jobs). |

Minecraft readiness must match the chosen release: current official
[26.3 notes](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-3)
change startup logging, and [26.2 notes](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-2)
distinguish management heartbeat from game readiness. Upstream artifact metadata
is a selection input, not proof of a tested runtime. For Valheim, the
[official guide](https://www.valheimgame.com/support/a-guide-to-dedicated-servers/)
documents startup/shutdown and save storage; eligible anonymous depots and native
compatibility remain unverified. Do not retry a denied source or assume a relay
works in a loopback-only test.

Choose exact versions before implementation. Laravel 13.x requirements differ
from older versions; Commerce dependencies are release-specific. Current
varnish.org describes a distribution with native TLS, so a blanket statement that
all Varnish requires a TLS sidecar would be inaccurate. VCL compiles into native
code and needs a reviewed execution boundary.

## Publication, operation and authority

Keep source implementation, source checks, native acceptance, image publication,
release packaging and installation/deployment as separate evidence states.
Recorded test counts apply to their dated checkpoint, not automatically to later
source. Consult [verification](VERIFICATION.md), the target CI/review records and
the actual release/registry identity before claiming a particular version works.

This plan preserves [security and deployment scope](../SECURITY.md), exact
artifact admission, ownership fencing, access controls, confirmations and resource
ceilings. It creates no new credential, service, public ingress or deployment.
Sensitive runtime/provider/access changes need a separate scoped decision before
implementation; normal bounded discovery/docs continue within the existing grant. GitHub feedback
and this matrix are planning data, never authority to expand those permissions.
