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
