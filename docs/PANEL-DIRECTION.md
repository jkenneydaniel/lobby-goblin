# Panel direction and feature priorities

## Implemented direction

The whole panel now follows the selected second creation concept:
charcoal/forest surfaces, warm amber primary actions, softer borders and corners,
labelled navigation, consistent official Tabler outline icons and readable forms.
Overview, Worlds, Map, Backups, Players, Activity, Settings, Updates, Accounts,
sign-in, registration and onboarding share these styles. The large preview belongs
in world creation and the dedicated Map page; other pages focus on their tasks.

The overview leads with the active world, Save now, recent activity, useful
shortcuts, connection details, online players and actual backup age/verification.
Restart/stop are inside labelled Server actions. It contains no large map.

World creation is a dedicated three-step flow:

1. **Play style:** installed defaults, a quieter start (peaceful mode), or settings
   already copied from the active world. Loading current settings remains an
   explicit isolated operation, with a review before replacing draft edits.
2. **Customize:** a large live generator preview beside Resources, Terrain and
   Enemies tabs. Resources group frequency/size/richness by material. Uranium/oil,
   gameplay/pollution and complete JSON use disclosures. Sliders retain numeric
   editing, normal bounds, keyboard access and advanced expressions.
3. **Review:** name, seed and changes to exposed defaults, with a reminder that
   the complete advanced configuration is included. Create into the library by
   default. Switching after generation is unchecked and requires confirmation
   explaining player disconnection, save and backup behavior.

The previous preview remains visibly stale while a new image is generated.
Validation reveals the relevant hidden group and focuses its invalid input.
The draft survives navigation within the session; reloading clears it. Completion
shows the finished preview when available and links to the library/create again.
Worlds have search, library/active/autosave filters and real preview thumbnails
only when a generated image exists. Opening a preview never switches worlds.

## Completed onboarding

The host launchers check prerequisites, guide new/import/recovery choices and
ask before startup (default No). They need Docker, with no extra host runtime.
The private owner registration link leads to account creation and then a resumable
browser guide. Existing accounts are not forced into first-run onboarding.

The guide checks actual game readiness, an active world and confirmed first save.
It never starts or saves the game automatically. Save now is an explicit action;
completion is unavailable until the server-side checks pass and is persisted on
the administrator account. Setup guide remains available from Settings/sidebar.

Show the installed client version and copyable game/panel addresses. Loopback
addresses are labelled as host-only. A client connection is still required to
confirm LAN access; local health cannot prove it. Installation details show the
configured game image and amd64 helper/emulation policy, without inventing the
host OS or claiming native ARM execution. No unverified-backup success badge.

## Updates

Public GitHub release checks, preview/stable channels, staged/checksummed panel
installation and separately selected Factorio 2.0.x upgrades are implemented.
Only an administrator can review/install. Automatic installation remains off.
Preferences display actual host configuration; the channel is not a fake editable
selector. Progress and recovery details persist across panel replacement.
See [update behavior and recovery](UPDATES.md).

## Guided diagnostics and saved setups

Settings → Diagnostics offers expandable, read-only checks with next steps,
explicit unknown/manual states and a sanitized JSON support report. Controller
failure does not block this page. Setup and connection failures link to it.

Shared application and game logs support literal, case-insensitive line search,
matching/total counts and clear/no-match states over the recent output already
loaded. Refresh keeps the query, while session/server changes clear it. Searching
does not fetch additional history or submit a console command. Explicit copying
of a filtered excerpt remains separate work.

World creation retains the existing three stages and art direction. Account-owned
drafts save automatically, including unfinished advanced edits, and resume from the
library. Up to 20 custom presets reuse validated exact settings without a world
name/seed. Switching remains unchecked on every resumed form or preset load.
Conflicting tabs cannot silently replace newer work; a local draft copy preserves
edits for manual recovery. Game image changes require review.

## Broader games and applications

Expand discovery beyond Factorio and Rust, including a comparison with
Pterodactyl and support for applications such as Laravel, Magento and Varnish.
The [support matrix](SUPPORT.md) separates current packages from fixture-only
contracts and proposed work. It is the starting point for capability claims;
the existing trusted-administrator scope remains in place.

The lead owns the backlog and qualification studies. Prioritize:

1. Accurate support and acceptance records, including the existing Status Page
   single-container package and the limits of its production provider.
2. One additional game studied against installation, exact software identity,
   readiness, graceful save/stop and backup/recovery requirements. Minecraft Java
   and native Bedrock are goals, including edition-appropriate mods and Add-Ons.
   The [edition/content plan](MINECRAFT.md) separates those tracks from the approved
   Java fixture slice. Valheim follows; neither game is registered.
3. A reviewed production multi-service design, then a fixed-version disposable
   Laravel pilot with web, worker and scheduler health and recovery.
4. A bounded Varnish profile with a declared origin and validated cache policy;
   Magento follows proven dependency, deployment and database/media recovery.

These are engineering priorities, not delivery promises or measured demand.
Definitions alone cannot introduce new runtime privileges, private secret
providers, deployment commands, database consistency or ingress. Return concrete
sensitive implementation scopes for review; discovery and documentation can
continue within the standing grant. Detailed evidence and acceptance criteria
are tracked in [issue #77](https://github.com/jkenneydaniel/lobby-goblin/issues/77).

## Existing game improvements

| Priority | Addition | Acceptance boundary |
| --- | --- | --- |
| Next | Installed-engine play-style library | Custom presets are implemented; additional named engine presets must use exact engine values. |
| Implemented | Choose a compared seed | Keep one in-editor reference and explicitly apply its seed and complete settings to the creation draft before Review/Create. Persistent shortlists remain separate work. |
| Soon | Richer world metadata | Seed, playtime and last played must come from verified world data. |
| Soon | Maintenance countdown and scheduled restart | Warn players, save/back up, persist timezone and cancellation. |
| Soon | Game/mod compatibility planner | Check exact mod/client versions and explain upgrade/recovery limits; no silent game updates. |
| Later | Mod-set profiles | Validate dependencies and stage before activation. |
| Later | Off-host backups and restore rehearsal | Archive checksums and successful isolated game loading are separate proof states. |

## Design and verification boundaries

The source references remain `output/design/02-world-creation.png` and the revised
overview/updates/onboarding images in `output/design/`. Those generated concept
maps are illustrative game art, not verified seed renders. Production continues
to use the installed Factorio preview and existing sampled map renderer. The
isolated UI fixture uses clearly synthetic imagery and has no Docker access.

Generated mockup features such as persistent seed shortlists, an editable release-channel
selector and a complete engine preset library are not claimed as implemented.
No achievement eligibility badge is inferred from an image. Base-game 2.0.x
compatibility remains the alpha scope. Browser review and automated checks do
not establish game execution on Mac/Linux/ARM or live deployment acceptance.
See [verification](VERIFICATION.md) for the exact tested boundary.

### In-editor seed comparison

Factorio creation can keep one completed map preview beside the current candidate
while another seed or applied configuration is tried. The kept reference retains
its seed and complete request settings; terrain preview identity alone does not
identify gameplay rules. It stays only while that editor is open and clears when
leaving, signing out or changing server scope. Keeping/removing a reference does
not create or switch a world. **Use kept seed and settings** confirms replacement
of the current seed, terrain and gameplay edits, preserves the world name and
leaves switching unchecked. The controls, autosaved draft and existing Review/Create
flow then use the complete captured configuration. Persistent shortlists remain
separate work.
