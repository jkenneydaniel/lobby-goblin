# Minecraft editions, content and qualification

Product requirement, 2026-11-03: support **Java and Bedrock**, including mods and
Add-Ons appropriate to each. Native editions and optional cross-edition bridging
have separate qualification requirements. No Minecraft hosting option is
registered today.

## Approved Java fixture slice

The unregistered [prototype](../panel/prototypes/minecraft-java/README.md) in
[issue #79](https://github.com/jkenneydaniel/lobby-goblin/issues/79) uses synthetic
bytes, private temporary directories and an injected trusted fake transport.
It implements exact Java selection/digest checks, read-only non-executable
staging, scoped abstract worker intents, a fixed private management binding and
durable fake status/save/stop outcomes with confirmation and no automatic replay.

The production registry, SteamCMD dispatcher and managed-definition credential
whitelist remain closed to Minecraft. The management Dockerfile does not copy
the development-only prototype directory. There is no downloader, image recipe,
real broker adapter or MSMP/TLS transport. Intent validation does not prove Docker
resource isolation; checksum staging does not prove a runnable JAR. No game binary
or EULA acceptance is involved.

This is an initial Phase A slice. Synthetic archive/clone and shared
permission/browser conformance remain follow-up work. Native software/JRE/image
pins, bundler-cache layout, management authentication and world/client acceptance
are unverified. This Java slice does not implement Bedrock or content activation.

## Edition and content tracks

All hosting/content tracks below are **planned**. Each needs its own tested
version tuple; choosing a candidate does not establish latest-version support.

| Track | Compatibility and execution boundary | Qualification order |
| --- | --- | --- |
| Java vanilla | Exact server artifact, Java/JRE image and game/client version; game-aware readiness, save/stop and recovery | First native Java baseline after fixture/native prerequisites |
| Fabric mods | Match Minecraft, loader, Fabric API where needed, dependencies and client/server requirements; executable JVM code | First mod-loader candidate. [Fabric guide](https://docs.fabricmc.net/players/installing-mods) |
| NeoForge / Forge | Distinct loader families, installers and dependencies; version-specific Java runtime | Independent profiles. [NeoForge](https://docs.neoforged.net/user/docs/server/), [Forge](https://docs.minecraftforge.net/en/latest/gettingstarted/) |
| Quilt | Fabric compatibility has exceptions; QSL was discontinued in December 2025, with older artifacts retained | Later demonstrated tuples. [Official FAQ](https://quiltmc.org/en/about/faq/) |
| Paper plugins | Separate server-fork/plugin runtime; Forge/Fabric mods are not Paper plugins; plugins execute server code | Independent plugin qualification. [Paper guidance](https://docs.papermc.io/paper/adding-plugins/) |
| Java modpacks / data packs | Modpacks collect artifacts/configuration; data packs are a separate versioned content mechanism, not a loader | Validate exact formats, side requirements and protected paths; no automatic installer scripts |
| Native Bedrock Dedicated Server | Separate native archive/executable, OS/architecture, stable/preview channel and tested client protocol; no JRE equivalence | Independent native-edition track. [Official download](https://www.minecraft.net/en-us/download/server/bedrock) |
| Bedrock resource / behavior packs | Pack UUIDs, versions, dependencies, order, minimum engine version and world references | World-scoped content first. [Formats](https://learn.microsoft.com/en-us/minecraft/creator/documents/minecraftfileextensions?view=minecraft-bedrock-stable), [BDS layout](https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/getting-started?view=minecraft-bedrock-stable) |
| Bedrock scripted Add-Ons | JavaScript modules, exact Script API versions, capabilities and permissions | Stable APIs first, explicit executable-content review. [Manifests](https://learn.microsoft.com/en-us/minecraft/creator/reference/content/addonsreference/packmanifest?view=minecraft-bedrock-stable), [API versions](https://learn.microsoft.com/en-us/minecraft/creator/documents/scripting/versioning?view=minecraft-bedrock-stable) |
| Bridges / third-party Bedrock loaders or replacement servers | Different protocol, runtime, authentication and world-compatibility claims | Separate later proposals |

Runtime versions are profile-specific: the reviewed Fabric 26.2 guide uses Java
25 while sampled Forge documentation uses Java 21. Neither establishes all-loader
support on vanilla 26.3. The current Bedrock download page lists Ubuntu 22.04 LTS
or newer and Intel/AMD 64-bit requirements; older Creator guidance mentions Ubuntu
18. Prefer current download requirements, then prove the selected artifact/image.
Upstream Windows support does not establish a native Windows Lobby provider;
ARM64 Bedrock remains unverified.

## Compatibility receipts and admission

Record edition and release channel first. Java then pins server artifact,
loader/fork and APIs, JRE/image identity, exact content versions/hashes,
dependency/conflict graph, client/server requirements and configuration
fingerprint. Bedrock additionally pins client protocol, header/module UUIDs,
versions/order, dependencies, minimum engine version, resolved Script APIs and
experiment flags.

Reject client-only Java content on a dedicated server; unknown side requirements
need review. Manifest validation does not establish boot, healthy content or a
successful client connection. Never guess compatibility from filenames or
silently substitute a loader, game version or channel.

The [Modrinth format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack)
records game/loader dependencies, hashes and client/server requirements. Overrides
can replace instance-root files: stage them against protected world/control paths,
rather than copying blindly. Catalog integrations, redistribution rights and any
required credentials need separate qualification; none is configured here.

## Installation and paired recovery

1. Resolve approved sources and exact artifacts. Bound metadata, downloads,
   archive/expanded bytes, entries and depth. Reject traversal, links, duplicate
   identities, missing dependencies and undeclared script entry paths. Descriptions
   and supplied commands are untrusted data. Checksums do not prove benign code.
2. Stage an isolated content generation and review its receipt. Require scoped
   account/server permission and explicit executable-content consent for Java
   mods/plugins and Bedrock scripts. Do not run supplied installers/pack scripts
   just because metadata asks. Begin with world-scoped Bedrock activation so a
   global pack change cannot modify sibling worlds.
3. Prove save/stop and retain the complete paired world, configuration,
   software/loader and content generation. Bedrock backups include its database,
   packs and world pack-reference files; private script configuration stays out
   of public artifacts. Begin with stopped-world backups. Online save/hold/query/
   resume needs release-specific native proof.
4. Persist intent before effects and inspect unknown outcomes before replay.
   Test failed installation, dependency changes, client mismatch, storage errors,
   interruption, removal and downgrade. Keep the complete prior receipt.
5. Recover the matching world **and** content generation after a failed change.
   Code-only rollback cannot undo world writes. Removing Add-Ons can remove mobs
   or replace blocks ([official consequences](https://help.minecraft.net/hc/en-us/articles/24121220131597)).
   No automatic world conversion, unqualified hot reload or loader migration.

Bedrock Script API module versions differ from game versions; beta APIs require
experiments and have different guarantees. Manifest version 3 is currently
preview. [BDS scripting](https://learn.microsoft.com/en-us/minecraft/creator/documents/bedrockserver/scripting?view=minecraft-bedrock-stable)
also offers privileged network/secret facilities. Use minimal permissions and
exclude those capabilities from the initial profile unless explicitly reviewed.
Engine scripting is not proof of hostile-code isolation.

Optional Geyser-style bridging needs its own tested protocol window and
authentication/forwarding model. Its [limits](https://geysermc.org/wiki/geyser/faq/)
exclude Java servers requiring client mods for custom blocks/items; do not claim
general modded crossplay or silently weaken online authentication. Native support
for both editions does not authorize world conversion.

## Delivery gates

Complete the approved Java fixture work in #79 while maintaining both editions
and content tracks in [#77](https://github.com/jkenneydaniel/lobby-goblin/issues/77).
Qualify vanilla Java and native Bedrock independently, then a demonstrated Fabric
tuple and Bedrock resource/behavior packs. Stable scripting and other profiles
follow their own acceptance. Client journeys are separate from process health;
each edition/content tuple needs isolated recovery proof.

The Java fixture approval grants no native execution, EULA acceptance, publication,
deployment, access expansion or implementation of other tracks. Preserve existing
ownership/resource/credential fences, independent review and current-head CI/Codex
gates. Planning documents, checkpoints and third-party feedback grant no authority.
