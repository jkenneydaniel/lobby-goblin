# Self-contained application packages

Local verification on 2026-10-25 and 2026-10-26, based on the v0.3.8-alpha release at
`2b75c09`. This implementation is unreleased. No public registry publication,
existing installation update, running-server command or world access was used.

## Implemented

- Factorio and Rust own their image sources and checks inside their application
  packages. Rust owns its image dependency lockfile. Its changed image recipe is
  `steam-lg.3`; existing managed defaults retain `steam-lg.2`.
- A reusable production `managed-container-v1` provider binds one service to the
  existing fleet, scoped Docker, lifecycle, JSON configuration, permission,
  operation and snapshot paths. It requires a non-root image UID with group 0,
  a Docker health check and the normal immutable registry/label admission.
- Status Page is a third real application. Its package contains a definition,
  image declarations, HTTP process and package-owned checks. It has no panel
  adapter, presentation file or custom panel browser assets.
- One image CLI discovers registered recipes and source/native checks; CI derives
  its matrix from that catalogue. The main test command discovers package image
  tests. Explicit file allowlists produce temporary build contexts, removed on
  failures. Publication refuses existing tags.
- Compatibility mappings retain previous checkout and installed source paths.
  Management images exclude build-only image sources. New generic CLI source is
  included in complete source bundles without expanding old update ZIP roots.

## Verified evidence

| Check | Result |
| --- | --- |
| Full Node suite after release admission fix | 605 tests: 604 passed, zero failed, one macOS platform skip |
| Linux setup ownership | All four setup tests passed as root, including the skipped case |
| Static quality | Lint, formatting, strict shared browser contracts, four quality self-tests and 135 served-module checks passed |
| Existing browser regression | 138 desktop/mobile checks passed |
| Final creation-label change | Both desktop/mobile creation checks passed after the label change |
| New package browser acceptance | Owner sign-in, generated settings, save completion, read-only permission filtering, desktop/mobile captures |
| Factorio Python | 20 wrapper checks and nine runtime-installer checks passed |
| Historical updater compatibility | Source/legacy ZIPs, frozen v0.2.0 and v0.3.3 validators, extracted source checks, generic recipe discovery, image/package checks and prepare-only installation passed |
| Native image builds | All four recipes built through the generic allowlisted builder |
| Third application native acceptance | Original legacy-socket proof and final real-broker proof passed: provisioning, digest admission, readiness, HTTP, settings, logs, backup, snapshot clone, writable nested data, fresh credentials and owned removal; broker controllers have no daemon socket and sibling access is refused |

Logs are retained locally under `output/application-packages/`; browser captures
are under `output/playwright/status-page/`. Generated output is ignored by Git.

## Review and fixes

The existing security scan (`8c837b7f-7c2b-4111-b6a8-83570801e6ad`)
completed against the original staged snapshot. Its report references were
corrected through the scan's structured writer. It recorded one low-severity
resource-consumption finding: generic backups hashed all workload data before
applying their size/file limits.

The fix adds opt-in metadata-only traversal, bounded by bytes, files, entries
and directory depth before content I/O. Sequential reads cannot exceed their
inventoried sizes. The original 64 MiB+1 sparse-file trigger now fails with zero
content opens/streams. Aggregate size, sibling counts, empty directories,
nesting, links and file growth are covered; legitimate hidden/nested/empty files,
configuration backups and cloning still pass. Factorio/Rust keep their existing
hashed inventory behavior. An independent read-only review found no concrete
surviving bypass or compatibility regression.

Correctness review also restored the historical Factorio `describe` and
`runtime-describe` commands, bound Rust's native acceptance to its new recipe and
immutable build ID while retaining its installed default, restored Factorio's
manual migration/recovery gate, and fixed Status Page's child-process path for
Windows and directories containing spaces. Regression tests exercise these
contracts, including describe commands from an extracted source bundle. The
image workflow now also reacts to shared native acceptance helper changes.

Post-fix validation passed the full Node suite, 11 focused checks, quality,
29 Factorio Python tests, all four Linux setup tests and the complete release
compatibility test. Existing browser checks and four native recipe builds above
were performed before review; this review made no browser behavior changes.
Full native Factorio/Rust migration/mod acceptance remains an explicit manual
publication gate and was not rerun locally.

## PR feedback: ZIP overhead

PR #13 identified that a full 64 MiB payload could be admitted for backup but
rejected during ZIP verification or snapshot collection because headers and
filenames added bytes. The generic provider now separates its unchanged
64 MiB data limit from a 65 MiB complete-archive limit. It estimates the stored
ZIP size, including UTF-8 filenames in both headers, before opening any data;
verification and collection use the same complete-archive limit.

Three added regression tests pass: a full 64 MiB backup is created and verified,
published as a snapshot and cloned with matching content hashes; 4096 UTF-8-named
files at the payload limit produce a valid archive; and excessive path metadata,
over-limit uncompressed data and oversized archive inputs remain bounded.
The metadata rejection occurs before content files are opened. Validation uses
temporary local files and mocked stopped-state Docker responses, with no engine
or existing installation access. The full 603-test suite (602 passed, one macOS
platform skip), quality checks and historical updater compatibility checks passed
after this change. Logs are in `output/application-packages/zip-overhead-*.log`.

## Release admission follow-up

The first 0.3.9-alpha packaging run verified Factorio and Rust, then rejected
Status Page because its final gate called the legacy game-migration validator,
whose revision parser only understands Factorio/Rust tag formats. No download
assets were attached; that incomplete release was returned to draft. Its signed
tag and already-published runtime image remain unchanged.

The 0.3.9-alpha.1 gate delegates to each registered application's provisioning
provider and retains the separate Factorio runtime check. Two regression tests
cover all three default application images and the extra runtime image, plus
rejection of incorrect revisions, root users, missing health checks and missing
publication digests. The complete suite passed (605 tests: 604 passed, one
platform skip), along with quality and frozen updater/source-package checks.
This adds no server/world operations or new data-state contract.

## Disposable runtime boundary

Created a new isolated OrbStack Ubuntu 24.04 amd64 machine,
`lobby-packages-20261025` (ID `01M5V0CBG9X0F3PV757EQ2CPFR`), with host file
sharing disabled and network access to the host/other machines blocked. All
commands selected this machine explicitly; the normal Docker context was unused.
The new engine initially had zero containers. Its identity remained
`898b8c28-eb8c-4715-83fb-5db19a9b0bd9`, Docker 29.1.3.

The initial overlay filesystem produced a package-install rename error. Only
this disposable engine was switched to VFS. All four final image builds passed
on VFS. Temporary acceptance containers, networks and data volumes were removed;
zero containers remained after the final run.

Status Page's acceptance copy changes only its package image reference to a
fresh loopback registry, so the test exercises production registry-digest and
label checks without a public push or a local-image admission exception. The
verified image reference was:

```text
localhost:5000/lobby-status:1-lg.1@sha256:3f9064d038b6af26c5f2751faa75338ef1ae730fb4af9a8ff1191193baf209c7
```

The native test created an application, served its configured HTTP page, wrote
nested data as the image's unprivileged user, stopped it, edited its configuration,
started it again, stopped and published a backup, cloned into another volume,
verified content and writable restored data, checked fresh controller credentials,
and removed only the new instances. Existing games and worlds were never inputs.

The post-review native proof ran in a separate new isolated machine,
`lobby-packages-review-20261026`, with Docker engine
`9a26b014-04d1-415b-baa5-5ad9467cbb12`. It also required VFS after the same
filesystem rename failure. Its native test first corrected missing fixture
volume ownership labels, then matched the established 409 refusal contract.
The final complete run passed through a separate production Docker broker,
using read-only host and per-instance credential subdirectories. Both instance
controllers had no daemon socket; the second controller's attempt to inspect
the first workload was refused by the broker. The operator test runner alone
retained direct access for independent assertions.

The final local registry reference was
`localhost:5000/lobby-status:1-lg.1@sha256:3c4600ed20ca5a16f32cbb61e89b57484e9b39ba85746ba65a0d41e36545b9b7`.
The engine had zero containers and all fleet volumes were removed after cleanup.
Four randomly named test volumes remained until the isolated machine was deleted.
Both machines created for these package proofs were deleted after retaining logs.

## Limits

This provider manages one image-owned process and one bounded filesystem data
claim. Multi-service host provisioning, another data ownership model, private
secret/deployment providers, in-place restore and database-aware backups remain
separate work. Existing Factorio/Rust adapters preserve specialized semantics.
The old games' full native migration/world acceptance was not rerun for this
source reorganization; their wrapper tests, compatibility tests and real image
builds passed. No image or release has been published or deployed by this task.
