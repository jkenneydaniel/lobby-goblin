# Offline Java fixture prototype

Owner-approved initial slice of the unregistered study in issue #79. From the
repository root on Linux, run `node --test panel/test/minecraft-fixture.test.js`.
The full test command also discovers it. Tests need no Docker, game binary,
installer, network request or real credential.

`provider.js` validates exact Java fixture selections, synthetic bytes and scoped
abstract worker intents. `fixture.js` stages data in a private caller-owned
temporary root with fixed filenames, a read-only non-executable artifact and
private durable receipts. Callers supply a trusted fake transport and a synthetic
40-character management credential; public receipts contain neither.

`metadata.js` checks an already-parsed synthetic catalogue: exactly format, kind
and releases, at most 64 entries and 64 KiB when serialized as UTF-8. Every entry
must satisfy the existing Java release contract; duplicate version IDs and
invalid unselected entries reject the catalogue. Selection requires an exact
version and returns a private immutable release for the existing worker and
preparation APIs. There is no latest-version fallback. A replacement catalogue
cannot mutate an earlier selected artifact or satisfy it with different bytes.
`parseJavaFixtureCatalogue` additionally accepts only a Buffer containing that
synthetic JSON format. Its 64 KiB limit applies to raw bytes before decoding,
including whitespace. It rejects malformed UTF-8, leading BOMs, malformed or
trailing JSON, duplicate object fields (including escaped aliases), nesting past
32 containers and invalid unselected entries. Ordinary whitespace and field order
are accepted. Decoder errors use fixed messages without source excerpts. The
returned catalogue is private and immutable; exact selection and preparation
retain their existing checks. Run `node --test panel/test/minecraft-catalogue-bytes.test.js`
for the byte-decoding and disposable preparation fixtures.

This is a synthetic JSON fixture contract, not actual Mojang manifest
compatibility, publisher authentication, TLS or transfer verification. Input
bytes are supplied by the caller; there is no fetcher, stream or downloader.

Preparation and save/stop intent precede effects. Interrupted outcomes survive
reconstruction as unknown and cannot be replayed automatically. An exclusive
private lock fences concurrent controllers. Preserve pending roots for inspection.
Bounded private journal temporary files left by process exit are preserved and
reported as interrupted writes. Inspection stays available, while preparation and
control replay remain blocked; temporary records are never promoted or removed.
The root is a fixture binding, not an admitted live game path.

Each trusted fake exchange receives an `AbortSignal`. The factory option
`exchangeTimeoutMs` is a per-call budget (default 5,000 ms, integer 1–30,000).
Expiry requests cooperative cancellation. Replies are checked against both the
signal and a monotonic deadline, so a callback that blocks the event loop cannot
turn an overdue reply into success before the timer runs. Timers are cleared on
every outcome. Initial-status expiry starts no save/stop; expiry during save,
stop or shutdown confirmation leaves the mutation outcome unknown and prevents
automatic replay or further controller-issued commands.

The operation lock remains held until the injected exchange settles. Its promise
must include all work and abort cleanup; it must not resolve while detached
effects continue. An exchange that ignores abort can keep completion pending
indefinitely. This is not a hard completion deadline or a whole-operation budget,
and cancellation cannot undo an already-applied effect. Abandoning an outer
caller's wait alone still does not cancel the operation before an internal
deadline expires. These are synthetic transport contracts, not real network or
MSMP/TLS qualification.

This directory has no production registration, image recipe, real broker adapter,
Mojang downloader, JAR semantic validator or MSMP/TLS adapter. Intent schema checks
are not proof of real resource isolation or a sandbox. Production dispatch and
managed-definition secret admission remain closed. The management Dockerfile
does not copy this development-only directory.

Upstream format/transfer and authenticated-control modelling, archive/clone and
permission/browser conformance remain follow-up Phase A work.
Native bundler/storage, authentication, save and world/client acceptance remain
unverified. See the [edition/content plan](../../../docs/MINECRAFT.md).
