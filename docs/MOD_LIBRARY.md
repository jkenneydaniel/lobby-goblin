# Live mod library

Administrators and assigned-server accounts with `mods.manage` can open **Mods**
in Factorio or **Mods & plugins** in Rust. This explicit permission authorizes
executable server code and reviewed lifecycle changes; use it only for trusted
server operators. See [server access](ACCESS.md).
**Browse** searches current upstream releases, **Installed** lists this server's
files, and **Updates** checks for newer releases. Nothing installs or updates in
the background. Every change requires review and confirmation.

On **Installed**, find an item by its displayed name or ID and combine that
literal, case-insensitive search with All, Enabled, Disabled, Modified locally
or Added manually. These filters cover the complete loaded list, preserve its
received order and make no request or mod change. Added manually follows the
existing label; locally modified items remain under Modified locally. Matching
and loaded counts distinguish an empty inventory from no matches. Clear filters
resets both controls. Browse search, Updates and change modes stay separate.

On **Installed**, **Download installed inventory** saves a local JSON report of
the complete successfully loaded list, including disabled, manual and modified
items in received order, even when the list is filtered. It includes only game,
scope, reported scope version,
item IDs/titles/versions, enabled/managed/modified flags and received valid SHA-256
digests; unknown versions and digests are `null`. It excludes account details,
paths, URLs, configuration and server identity. The download makes no request or
mod change and is unavailable while loading or after a failed refresh.
These are loaded observations, not live verification, a compatibility/restore
report, an importable modpack or a backup. Factorio built-ins are outside this
mod-ZIP list. Rust's reported scope version describes its framework, not its
Steam build; enabled files do not prove compilation or runtime loading.

Choose **When applying changes** before reviewing a mod:

| Choice | Factorio | Rust |
| --- | --- | --- |
| Keep server stopped · start it myself | Apply while stopped; leave stopped | Apply while stopped; leave stopped |
| Save, stop, apply, and start automatically | Save/stop if running, apply, then start | Save/stop if running, apply, then start |
| Apply while running · Rust plugins | Unavailable: mods load at startup | Load/reload/unload through Oxide or Carbon while ready |

The stopped option is the default. Automatic start is explicit, including when
the server was already stopped. Review describes the selected behavior and
player interruption. Reviewing downloads and verifies files without changing
game files or stopping a server. Changes use the normal serialized job queue.

## Factorio

The library uses the official [Mod Portal API](https://wiki.factorio.com/Mod_portal_API).
Browsing needs no upstream account. Downloads need a Factorio username and
service token with mod access; an administrator enters these in **Factorio
download account**. Delegated mod operators can use the connected account but
cannot connect or disconnect its credentials.
The controller stores them privately with restrictive file permissions and
returns only connection status to the browser. Disconnect removes that file.

Browse filters releases for the installed Factorio series. Review resolves
required dependencies, version constraints, conflicts and enabled expansion
features against the enabled mod set. It includes every downloaded dependency.
Unsupported or unsatisfiable combinations are refused. Large sets are bounded
to 50 mods and 1,000 resolution attempts. The file set is limited to 256 MiB;
each Factorio ZIP is limited to 64 MiB and each Rust source to 512 KiB. Private/unpublished mods may need
manual reconciliation before the resolver can validate the set.
Unpacked mod directories also require manual reconciliation; the library manages ZIP packages.

Packages are checked against the portal checksum, ZIP metadata and dependency
metadata. Changes replace the selected ZIPs and update `mod-list.json`, preserving
other mod settings. Disabling/removing a required dependency is refused.
Installing a mod enables it and its required dependencies. Factorio loads changes
at the next start; there is no hot reload. Players can synchronize mods when joining.

## Rust

Install Oxide or Carbon through **Framework, uploads & configuration** first.
Framework changes still require stopped Rust and their own review. The library
lists public Rust downloads from [uMod](https://umod.org/plugins?categories=rust).
Paid plugins and other marketplaces remain manual uploads.

Review verifies the plugin checksum and matching upstream dependency manifest.
Required plugins must already be enabled with a supported matching version;
complex upstream dependency expressions are refused instead of guessed.
Updates preserve disabled state and leave configuration/data alone. Removing a
plugin also preserves configuration/data. Locally modified or unmatched sources
are shown in Installed and skipped by Updates.

The optional running mode sends the selected framework's load/reload/unload
commands. Inspect **Logs** afterward: accepting a reload command does not prove
successful asynchronous compilation or compatibility. Plugins execute server
code, and some require a restart or additional configuration. Use automatic
stop/apply/start when appropriate. Carbon compatibility remains plugin-specific.
Private source-file permissions or a missing initialized plugin folder require
the stopped-server option so the game's next startup can normalize ownership.
See the official [Oxide plugin commands](https://docs.oxidemod.com/core/commands/plugin)
and [Carbon command reference](https://carbonmod.gg/references/commands/).

## Reviews, failures and recovery

Reviews pin downloaded bytes with SHA-256 for 15 minutes. A changed game version,
framework or installed file set invalidates the review. Downloads allow only
HTTPS on the relevant upstream hosts, with time and size limits. Catalogues are
cached for five minutes (ten for Factorio); failed ordinary requests can show
cached data up to 24 hours old, visibly marked. **Refresh catalogue** forces an
upstream request and reports failures.

Before changing files, the controller keeps previous sources and a durable
journal. A file failure attempts rollback; interrupted rollback blocks controller
start and other game operations until recovery. Stop the server and use
**Recover mod change**. Recovery restores previous sources and leaves the server
stopped. If a file was edited outside the transaction, automatic rollback
preserves it; explicit recovery keeps an extra private copy before restoring.
If preparation fails before any reviewed files are applied, automatic mode
resumes a server that this operation cleanly stopped. An already stopped server
remains stopped, and incomplete transactions still require recovery before
startup. A failed restart is reported explicitly while preserving the original
preparation error.
A startup failure after successful installation leaves the new files installed
and reports that the server did not become ready. Inspect Logs before retrying.

Factorio records live in controller `state/mod-library/`; its download account is
`state/factorio-mod-account.json`. Rust records live in `state/mods/mod-library/`,
included in complete modded backups under `mod-state/`. Keep recovery copies
private. These copies recover mod files; they do not undo gameplay or plugin
data changes. Take a verified complete backup before changing a modded world
that you may need to roll back.

Disposable tests do not establish native game compatibility. No installation,
running server or existing world was changed to implement or test this feature.
