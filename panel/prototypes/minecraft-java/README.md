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
This is a fixture data contract, not actual Mojang JSON compatibility, wire-JSON
parsing, publisher authentication, TLS or transfer verification.

Preparation and save/stop intent precede effects. Interrupted outcomes survive
reconstruction as unknown and cannot be replayed automatically. An exclusive
private lock fences concurrent controllers. Preserve pending roots for inspection.
Bounded private journal temporary files left by process exit are preserved and
reported as interrupted writes. Inspection stays available, while preparation and
control replay remain blocked; temporary records are never promoted or removed.
The root is a fixture binding, not an admitted live game path.

This directory has no production registration, image recipe, real broker adapter,
Mojang downloader, JAR semantic validator or MSMP/TLS adapter. Intent schema checks
are not proof of real resource isolation or a sandbox. Production dispatch and
managed-definition secret admission remain closed. The management Dockerfile
does not copy this development-only directory.

Upstream format/transfer and authenticated-control modelling, archive/clone and
permission/browser conformance remain follow-up Phase A work.
Native bundler/storage, authentication, save and world/client acceptance remain
unverified. See the [edition/content plan](../../../docs/MINECRAFT.md).
