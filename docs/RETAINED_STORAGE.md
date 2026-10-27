# Retained server storage

Removing a server keeps its original data volume. Open **Storage** as a panel
administrator to inspect, recover or permanently delete that data on its source
host. Shared snapshots have their own controls in **Snapshot library**.

1. Choose **Inspect storage**. This checks ownership, container references, file
   counts, size and application recovery readiness without changing the volume.
2. To recover, expand **Recover into a new server**, choose its name and confirm
   the removed server's name. Allow enough free disk space and host memory for an
   independent server. The new game stays stopped until you open and start it.
3. To delete, expand **Permanently delete retained data**, type the removed
   server's name and confirm permanent deletion. This deletes its original
   worlds, player progress, settings, software and local backups. Shared snapshots
   and independent copies are kept.

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
recovery. A partial failed copy stays allocated for review; the original volume
is preserved. Follow progress and inspect interrupted work in **Operations**.

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
