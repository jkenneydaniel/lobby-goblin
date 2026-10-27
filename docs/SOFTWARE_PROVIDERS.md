# Software installation providers

Software delivery is independent of container provisioning. Application packages
keep their image recipes, configuration, protocols and native acceptance. Shared
software providers resolve and install an application's reviewed software source.
Factorio keeps its official headless download provider; Steam applications use a
SteamCMD provider. A shared SteamCMD image is an explicit pinned dependency, not
an application or an implicit source-tree dependency.

## Compatibility and current scope

The existing software policy remains version 1. Runtime policies may optionally
declare versioned capabilities: supported Linux platforms, anonymous or account
authentication, discovery, repair, updates, historical versions and adoption.
An opted-in policy cannot exceed its trusted registered provider's capabilities.
Policies without capabilities retain their exact public metadata and provider
interface. Image-delivered applications cannot declare runtime capabilities.

New installation records are additive. They do not replace Factorio's existing
version:1 receipts, rename installed files, enable updates or adopt old data.
The record validators and transitions are pure functions. Persistence, locking,
read-only inspection and effect execution belong to the provider/operation
implementation. A revision check must be coupled to the existing operation lock
and atomic record publication; a validated record alone is not evidence that
software was installed.

## Exact software and verified completion

Selections have format 1, provider and application IDs, an exact Linux platform,
an exact softwareVersion and a source:

- Steam: dedicated-server appId, branch, resolved buildId and sorted unique depot
  IDs/manifest IDs. softwareVersion is the buildId. Numeric Steam identities are
  decimal strings so 64-bit manifest IDs cannot lose precision in JSON.
- Archive: the reviewed provider's SHA-256 checksum. Download URLs are resolved
  inside the provider, not supplied by requests or persisted in selections.

The canonical selection key covers all these fields. A public branch is a
requested channel, never an exact installation identity. If its resolved build
moves during staging, activation must refuse that different build.

A completed receipt contains the selection and a SHA-256 inventory digest with
file and byte counts. The full inventory is provider-owned and must be verified
against files before the receipt is trusted. The shared envelope bounds file
counts to one million and software bytes to 1 TiB; each provider must set suitable
smaller operational limits. The record does not contain credentials, arbitrary
commands, URLs or host paths.

## Installation state and recovery

The serializable record includes a revision and one of:

| State | Meaning |
| --- | --- |
| uninstalled | No completed software receipt has been recorded |
| preparing | A fresh operation is preparing an installation |
| downloading | An exact target is being staged |
| validating | Staged software is being checked |
| activating | Activation has been submitted; uncertainty now needs inspection |
| installed | The completed receipt identifies the active installation |
| failed | Failure before activation preserves the prior installed receipt |
| recovery-required | The outcome is uncertain; new work is fenced |

Every transition checks the expected revision. Active work keeps its operation
ID and target; a safe retry needs a new operation ID. The prior installed receipt
remains in the record throughout an update. Failed-state error values are bounded
codes; provider error text and authentication responses are not public progress.

After activation, failure cannot be represented as an ordinary safe-to-retry
failure. Recovery requires explicit review and a trusted read-only observation
of the previous or target installation. A missing artifact does not prove a
worker is stopped: an inspector must establish both the installation identity
and that no operation remains active. Unknown outcomes remain fenced.
Inspection can also prove a staged target ready for a separately confirmed
activation, or a known partial first download safe to retry. These observations
do not claim an active installation and never discard a prior receipt.

Legacy adoption is a separate explicit operation. Its read-only inspector must
verify the software and application/provider/platform identity before publishing
a completed record. Adoption cannot download, run Steam validation, overwrite
software, stop a server or reset world/configuration/mod data.

## Delivery sequence

1. Contract and compatibility: capability declarations, exact identities,
   bounded receipts and guarded state/recovery/adoption transitions.
2. SteamCMD base and provider: private staging, durable publication, verified
   completion, progress and safe restart/retry. Start with anonymous Linux
   dedicated-server downloads. Deliver this step as two PRs: shared image and
   exact metadata discovery, then the staged installer.
3. Rust integration and managed software updates: real server build discovery,
   mod-aware staging, save barriers, paired software/data recovery and failure
   injection. Keep old image defaults and installations until explicit adoption.
   First move the separately versioned Rust image onto the published shared base
   without changing bootstrap behavior; follow with provider/update integration.
   Package private preparation in a reusable unprivileged worker before adding
   controller/fleet wiring. Keep activation and real lifecycle inspection in the
   controller; a preparation request cannot claim the application is stopped.
4. Setup experience: capability-driven host/version choices, preflight,
   installation progress, useful retry and session-expiry regression coverage.
5. Package authoring: generator, validator, documentation and native acceptance
   scaffolding that select reviewed providers.
6. Second Steam integration: Valheim, using its publisher's dedicated-server
   requirements. Confirm the actual server app/depot identity through Valve
   metadata when implementing the provider. Its log-based readiness and SIGINT
   shutdown exercise different protocols from Rust's WebRCON. Begin with vanilla
   Steam-backend hosting; declare optional backends only after their own tests.
7. Native architectures: validated platform selection through image tooling,
   managed profiles, fleet, agents, migration, broker and Factorio's eligible
   download/helper paths. Historical pinned versions remain unchanged.

Each step is a separate PR. Complete review, address feedback and pass CI before
merging and starting the next PR. Validate real games only on explicitly selected
disposable hosts. Release/package changes must retain frozen v0.2.0 and v0.3.3
updater compatibility and existing source layouts. Publication and operational
adoption/deployment are separate actions; these changes do not authorize
accessing existing worlds or changing running servers.

## Brokered preparation workers

A managed application may declare `helpers.softwareWorker` with version 1,
provider `steamcmd`, its reviewed source and required executable files. This is
trusted package data, never a Docker specification supplied by the panel user.
No existing application opts in as part of the broker contract change.

The broker pins both the published worker manifest and image configuration
identity. It permits only the fixed executable, no added environment values,
the instance's bridge network and bounded CPU, memory, process and log usage.
The worker runs as UID 1000 with GID 0 and no capabilities. Group access applies
only to controller-created private claims: request input is read-only, result
output is writable, and preparation additionally mounts private software and
provider control directories. Application data, daemon sockets and management
credentials are never worker mounts. Controllers must create the group-accessible
claims before requesting a worker; file exchange and durable request recovery
are delivered separately before enabling an application.

Metadata resolution reserves 512 MiB without provider storage. Preparation needs
2 GiB and an explicitly stopped application allocation of at least that size.
The worker temporarily uses its own stopped application's memory reservation;
all other stopped applications retain theirs. Creating and starting containers
are serialized across host and instance capabilities. An existing preparation
claim blocks application start until the worker has stopped and been deleted,
including created or exited workers whose outcome still needs inspection.
Cancellation can stop the worker without waiting behind that admission queue.

An instance may start its created worker once, inspect it, obtain bounded logs,
wait, stop it and remove it after stopping. It cannot replay an exited worker,
execute commands or read archives. The host can inspect, stop and delete a
verified worker even after its application/controller has been removed, but
cannot start it. A controller must retain uncertain requests for inspection;
the broker alone does not make an interrupted operation safe to retry.

`SoftwareWorkers` is the controller's trusted file-exchange adapter, available as
`ctx.softwareWorkers` only to a declared managed application with broker transport.
`run('resolve', {channel})` resolves the reviewed source;
`run('prepare', selection, {confirm: true, id})` prepares an exact selection.
Neither action stops an application, activates software or starts a game.
The controller retains activation authority and must independently inspect real
lifecycle and provider state before using a prepared candidate.

Requests and operation journals live outside application data. The controller
publishes a durable intent before create/start, starts each request once and
checks the bounded response against its source, action, exact target and exit.
Interrupted or uncertain requests block new preparation after reconstruction.
`inspect(id)` is read-only; `cancel(id, {confirm: true})` stops only that worker.
Closing an unchanged stopped observation needs explicit offline confirmation and
does not clear provider recovery state, activate software or claim installation
success. A parent operation acknowledges retained terminal requests after it has
recorded their result. History is capped at 128 unacknowledged requests.

The controller creates private claims with group access for UID 1000/GID 0 and
normalizes only its own known provider control records before admission. This
lets a subsequent worker read controller-owned activation records without CHOWN
or FOWNER capabilities. Worker-owned inventories and releases retain their
ownership. Native acceptance uses the published worker, the real broker and
restricted controller credentials on a fresh engine, with a copied text sentinel
and an idle Node fixture; no game executable or existing world is involved.

Inspection reports missing initialization metadata and invalid protocol records
as uncertain observations. Invalid bytes produce a validation code and bounded
fingerprint, never a successful response. Oversized records use a bounded prefix
digest plus file size and change timestamps. Offline closure binds these
observations again before clearing request metadata, so altered bytes invalidate
the review. Partial request initialization has the same explicit closure path;
it cannot replay create/start or infer an installation outcome.

Publisher guidance: [Valheim dedicated servers](https://www.valheimgame.com/support/a-guide-to-dedicated-servers/),
[Rust dedicated servers](https://wiki.facepunch.com/rust/Creating-a-server) and
[Steam dedicated-server distribution](https://partner.steamgames.com/doc/sdk/uploading/distributing_gs).
