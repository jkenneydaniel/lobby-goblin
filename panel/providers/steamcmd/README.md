# Shared SteamCMD software provider

This provider owns the reusable SteamCMD image and bounded Steam metadata
handling. Applications retain their own settings, protocols, save/shutdown
behavior, image dependencies and native acceptance.

The shared image is registered in panel/providers/registry.json, independently
of the application registry. It uses a digest-pinned Node/Debian parent, verifies
the official SteamCMD bootstrap checksum and defaults to UID/GID 1000:1000. Game
binaries are not part of this image. Application-specific libraries belong in
the application image.

Use the existing image CLI with shared/steamcmd/runtime. Source checks also run
in the normal test suite. Native acceptance runs only on an explicitly selected
disposable engine or a fresh Actions job. It executes SteamCMD anonymously and
checks Rust dedicated-server metadata, not client news or game downloads.

KeyValues parsing is bounded and rejects duplicate/unsafe keys and ambiguous
roots. Sources declare an application ID, dedicated-server app ID, allowed
branches and linux/amd64. Discovery records the exact build and eligible Linux
depot manifests without converting 64-bit IDs to JavaScript numbers.

The initial resolver supports anonymous, unencrypted, app-owned Linux depots.
Shared-app or encrypted depots are explicitly refused until a reviewed resolver
can identify their exact manifests. No account or password is accepted.
Installation arguments always select the reviewed branch explicitly, including
public, so a previous beta setting cannot leak into a new installation.

Steam's installed appmanifest must report completed StateFlags and exactly the
reviewed app, branch, build and depot set. This metadata is only one part of
completion: the staged installer must separately verify the downloaded inventory
before publishing a receipt.

Image recipes may declare one dependency whose repository and platform match
their immutable baseImage. Targeted local checks/builds include prerequisites in
dependency order; cycles and missing references are refused. CI image jobs use
published pinned bases, so a new shared base must pass review/native acceptance
and be deliberately published before applications pin its digest. Shared image
tags remain immutable. Publishing a base does not change any installed server.

## Staged installation

createSteamProvider requires separate canonical software and private control
roots, required executable/data files, and reviewed empty/stopped application
inspectors. Callers must keep control and staging out of the game's writable
mounts; expose only the selected release read-only and keep worlds/configuration
separate. Existing data without an installation record is not implicitly adopted.
The provider is not wired into existing Factorio/Rust startup by this step.

resolve and inspect do not change application storage. An installation resolves
the requested branch again before a download and refuses a changed target. It
reserves disk headroom for staging/temporary data, downloads into an
operation-owned directory, checks the completed Steam manifest and required
files, and hashes a bounded regular-file inventory before publishing anything.
Only the same failed target can reuse its private partial directory. Completed
local releases can be verified and reused without a Steam query or another
payload download, even after the upstream branch moves. Resolving an arbitrary
historical version or downloading a missing old build remains unsupported.
Reusing a release durably binds its verified receipt to the new operation before
publishing that operation's state. Separate bounded binding records preserve
earlier recovery evidence if interruption occurs before the next candidate.

The active receipt is separate from staging. activate requires an explicit
confirmation, a matching staged operation/revision, verified files and a
definitively stopped application. It persists activation intent before changing
the active receipt. Failures retain the previous software and fence uncertain
outcomes; they never load a world or run a game.

Recovery is explicitly offline, binds the inspected lease/revision/observation,
and refuses known live workers. A verified active receipt can settle an uncertain
operation; verified staged software can return to validation for a separately
confirmed activation; a known partial first download can become a failed/retryable
operation. Unknown or corrupt state remains fenced. Missing files alone never
authorize replay. Completed receipts verify offline and do not resolve a newer
upstream branch during restart.

Workers use argument arrays, a minimal environment and bounded output/progress.
Cancellation kills the private Steam worker group and awaits process completion
before returning. Inventories reject links, bound metadata before payload reads,
limit path metadata to 32 MiB and detect files changing during hashing.

Normal CI uses temporary filesystem/command fixtures and real metadata-only
image acceptance. Deliberate workflow_dispatch acceptance also installs Rust
software in a fresh named unprivileged container, verifies it, and reconstructs
the provider with Steam unavailable. It never starts a game, creates a world,
publishes application images or accesses an existing installation.

## Preparation worker

The shared/steamcmd/worker recipe packages the provider and its registered shared
module closure into an unprivileged image. Its only commands are resolve,
prepare and inspect. It cannot activate, adopt, recover, run a shell or launch a
game. Application/controller integration is a separate step; existing startup
paths do not select this image.

The container reads at most 64 KiB from /request/request.json and atomically
writes a bounded response to /result/result.json. Requests use format 1, a UUID
id, an action, a reviewed source and requiredFiles. resolve also requires an
initial channel. prepare requires the exact selection and confirm: true; its
operation ID is the request ID. Unknown fields, paths, executables, environment
values and lifecycle assertions are refused. Responses echo the request ID and
contain ok plus result, or a bounded error without raw Steam diagnostics.

Mount only the instance's private software tree at /software and private provider
state at /control, the request directory read-only at /request, and its result
directory at /result. Storage must be accessible to UID/GID 1000. Never mount
worlds, game-writable directories, a daemon socket or controller credentials into
this worker. Cancellation aborts its private Steam process group.

prepare is an explicit preparation-only provider method. It can stage in empty
private software storage without access to the application. It does not publish
an active receipt. The controller must activate through its own provider instance
with trusted lifecycle inspectors. First activation checks that the application
is empty, and checks empty/stopped state again after verifying the files.
Ordinary stage/install retain their existing empty-application guard.

The software-provider-v1 image runtime profile permits a fixed set of five public
core modules. Recipes cannot supply shared-source paths or replace those modules.
The isolated context includes a minimal module package and provider-owned source;
it needs no bundler or runtime package download.

Normal native acceptance imports that isolated runtime with networking disabled
and rejects lifecycle commands. Deliberate workflow acceptance also runs the
actual file request protocol for a fresh Rust download, then proves separate
offline controller activation and restart. It never launches a game or world.
