# Server storage

Open **Server storage** as a panel administrator to see registered server volumes
across connected hosts. Filter by host or storage status, or search by server,
application or volume name. Assigned storage belongs to an existing server; use
**Open server** to manage it. Recovery and deletion are limited to removed servers.
Shared snapshots have their own controls in **Snapshot library**. This is not a
general Docker volume browser: unrelated host volumes are not listed.

Removing a server keeps its original data volume. Its retained data stays in this
list until explicitly deleted. Deleted entries are available under **Deleted
history**. If a host goes offline, previously loaded storage stays visible as
last known information, with actions disabled until the host reconnects.

1. Choose **Recover**, **Delete data** or **View details** on retained storage. A
   read-only safety check runs automatically when needed, with progress shown
   inside the selected entry. There is no separate inspection step to find.
2. To recover, choose the new server name, type the removed server's name and
   confirm the copy. Allow enough free disk space and host memory for an
   independent server. The new game stays stopped until you open and start it.
3. To delete, type the removed server's name and confirm permanent deletion.
   This deletes its original worlds, player progress, settings, software and local
   backups. Shared snapshots and independent copies are kept. Completing the
   safety check never submits recovery or deletion automatically.

Checks run only when an administrator chooses a retained-storage action. Opening
the page and using filters do not scan server files or start storage workers.
Assigned volumes are not scanned; the page does not estimate their size. The
selected action and form edits survive background refreshes. Failed or expired
checks offer **Check storage again** without silently retrying an operation.

Inspection expires after fifteen minutes. Ownership and the file inventory are
checked again before recovery or deletion. Any container reference, including a
stopped or unmanaged container, blocks both operations. There is no force-delete
or general Docker volume cleanup action. Missing or unsafe volumes require host
operator review. Update remote host agents to the same release before using the
new storage operations.

Recovery copies application data, installed software, local backups, presets and
declared stable application state. It creates new management credentials, ports,
containers and storage. Factorio keeps worlds and mods, with automatic map
refresh and live tracking disabled in the copy. Rust keeps player databases,
frameworks/plugins and its exact managed software records; its runtime's declared
internal links are recreated without following them. Legacy oversized Rust seeds
are normalized only when the retained save matches Rust's clamped seed and world
size. Management job history, worker requests and old control credentials are not
copied. Completed private update transaction archives remain in the original
volume; ordinary backups are copied.

Interrupted software, framework, mod, image or storage changes require manual
recovery review before copying. Unexpected links and special files also block
recovery. A partial failed copy stays allocated for review and cannot be used
as a completed recovery source; the original volume is preserved. Follow progress and inspect interrupted work in **Operations**.

## Application adapters

The optional trusted managed adapter hook is `retained: {version: 1, state,
inspect, rebind}`. `state` lists stable paths under `state/`; `inspect` checks
read-only source metadata and unresolved transactions, and `rebind` updates
application identity and credentials in the fresh destination. These hooks are
application-owned code, not request-supplied paths or modules. The generic
container provider supports recovery when its definition fingerprint matches.
Adapters without this hook still support inspection and explicit deletion, with
a clear explanation that recovery requires manual review.

Inventory is bounded to 250,000 entries, 1 TiB of ordinary file sizes and 64
directory levels. Copying streams and verifies each file and preserves its owner
and ordinary permission bits. The source mount stays read-only. The registry
format is unchanged; storage inspection metadata is optional, and existing
snapshot and updater formats remain supported.
