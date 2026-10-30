# Factorio map performance and draft controls

This review uses source inspection and synthetic fixtures only. No running
server, existing save, Docker daemon or deployed panel was used.

## Implemented

- Snapshot objects and chunk origins are indexed in fixed spatial cells. Frame
  drawing and selection query the visible region or click neighborhood. Export
  order is preserved, including enemy priority and equal-distance selection.
  Broad and sparse overviews fall back to a bounded scan rather than walking
  empty cells across arbitrary map coordinates.
  Query padding follows the snapshot's largest finite object extent so oversized
  modded/older objects remain visible and selectable across viewport edges.
- Terrain is decoded on first visibility into one atlas instead of one canvas
  per chunk. Run-length terrain is painted in row spans. A uniform chunk takes
  16 fill calls instead of 256; a 2,048-chunk map uses one atlas instead of 2,048
  canvas objects. The atlas is approximately 2 MiB of RGBA pixels at that limit.
- Map refresh settings persist automatic refresh on/off and a minimum interval
  of 0–1440 whole minutes. Zero preserves every-save refresh. The queue retains
  only the latest completed save, persists the last export start, and retains
  existing retries. Preferences become active only after durable storage succeeds.
  The separate server-scoped `application.factorio.map.configure` permission
  controls changes; manual export, autosaves and live-player polling are separate.
- Cancel draft settles pending autosaves, uses the saved revision/draft identity,
  then returns to the library without automatically starting another draft. A
  stale discard retains the editor. Cancellation is unavailable while a world
  operation is active. It discards draft settings only: requested terrain previews
  can finish, and submitted world creation is not cancellable through this control.
  Preview seed callbacks and new autosaves pause before the discard, preventing a
  delayed preview from recreating the draft. Refused discards resume those controls.

## Reproduce the query measurement

Run `node panel/test/map-benchmark.mjs` with Node 24. It generates deterministic
object coordinates in memory and compares 120 matching viewport queries per pass.
Both paths receive three warm-up passes, followed by seven measured passes with
alternating order; the table reports median query times. A local run on October
27, 2026 produced:

| Synthetic objects | Index build | Full scans median | Indexed queries median | Average candidates |
| ---: | ---: | ---: | ---: | ---: |
| 80,000 | 6.85 ms | 65.35 ms | 7.34 ms | 1,925 |
| 160,000 | 16.41 ms | 129.88 ms | 12.33 ms | 1,925 |
| 320,000 | 19.23 ms | 258.62 ms | 12.39 ms | 1,925 |

These timings vary with hardware and load. They measure lookup work for zoomed
views, not GPU frame time, Factorio tick rate, gameplay or end-to-end exports.
An overview that shows every object still needs to paint every visible object.
The browser fixture separately exercises an 80,000-object, 2,048-chunk map,
including zoom, fit, inspection, layers and one atlas allocation on desktop/mobile.

## Remaining limits and evidence needed before increasing them

The existing export contract remains version 1, limited to 2,048 chunks,
80,000 objects and 24 MiB of JSON. Existing snapshots and updater layouts remain
compatible. This change does not claim larger saves fit the one-GiB helper.

The exporter still enumerates and sorts all charted chunks, samples terrain,
classifies entities, and makes sequential 16-chunk RCON batches in an isolated
world copy. Full JSON is transferred and parsed when a new snapshot arrives.
The earlier renderer still painted every visible object at overview zoom; the follow-up below addresses resource/building overviews. Larger export
limits should follow disposable Factorio measurements of helper peak memory,
export duration, JSON size/parse cost and mobile frame timing at representative
density. Useful subsequent work is bounded overview aggregation and measuring
engine-side entity filtering or batch size, with modded-object and enemy-priority
fixtures. A browser index microbenchmark alone is insufficient evidence to raise
the export limits.


## Focused rendering and fetch follow-up

The primary activity is browsing a saved factory: pan/zoom stays responsive,
objects remain inspectable, player movement does not redraw the whole factory,
and requesting a fresh export is an explicit, rate-limited operation.

### Review findings and changes

1. `map.js` redrew terrain and all visible entities whenever a live-player response
   arrived, including disabled/unchanged tracking. Cache the static base in one
   additional canvas. Only redraw that base for camera, size or relevant layer
   changes. Player/pin overlays reuse it; identical player data schedules no frame.
   Cap the drawing pixel ratio at two to bound high-density mobile canvas costs.
2. The existing spatial index helps close views, but an overview includes the
   whole object list. At less than half a pixel per tile, group resources and
   buildings into occupied visual cells. Keep at most two derived levels cached.
   Exact source objects remain the authority for selection. Enemies, rails and
   oversized objects stay exact; this is not sampling or deleting snapshot data.
3. Pin edits and unrelated completed operations fetched the full JSON, destroyed
   the canvas and rebuilt indexes/terrain. Optional revision requests now return
   only current metadata and pins when the file is unchanged. Pin changes keep
   the renderer and form state. Revisiting the page reuses one session-scoped
   snapshot in browser memory. The controller coalesces full reads but retains
   only small metadata after delivery; no shared or persistent browser cache is used.
4. Map-status polling follows its own 30-second budget, independent of the shared
   application's five-second status/job checks. Known running map operations use
   five-second progress checks. Live positions poll every five seconds, with a
   shared controller cache of 4.5 seconds; disabled tracking checks once a minute.
   Hidden tabs skip map/player polling. Player rows use delegated actions instead
   of retaining fresh listeners on every telemetry response.
5. The existing **Refresh map** button now shows a two-minute countdown. The
   controller reserves that budget durably before saving/exporting, and recent
   automatic exports count toward it. The budget survives restart and applies
   across users. Browser timing is presentation only. Manual refresh still saves
   current progress; automatic refresh uses completed saves without an extra save.
6. New automatic-refresh settings default to 15 minutes. Existing saved intervals,
   including explicit every-save refresh, remain unchanged. Save detection polls
   every five seconds and skips log work while automatic refresh is disabled.

### Browser measurement

A loopback-only harness imported the actual before/after renderer modules into
Chromium at 1440 × 1000. It generated deterministic, unique object coordinates,
uniform terrain and a 90% resources / 10% buildings mix. Each run used a fresh
canvas/control set, 15 alternating pans (first three excluded), and five identical
player updates. The values below are medians of three runs on the same machine.
Timers measure JavaScript callback work, not GPU presentation, network load,
Factorio export duration, tick rate or guaranteed frame rate.

| Snapshot | First draw before → after | Pan callback before → after | Rectangle fill calls per pan before → after |
| --- | ---: | ---: | ---: |
| 80,000 objects / 2,048 chunks | 40.3 → 28.0 ms | 23.8 → 21.3 ms | 80,001 → 80,001 |
| 320,000 objects / 8,192 chunks | 947.4 → 112.2 ms | 144.8 → 20.6 ms | 320,001 → 41,581 |

Five unchanged player updates previously caused five complete draws; afterward
there were zero scheduled draws. A moving marker now copies the cached base
instead of traversing all terrain/objects. Terrain draw calls still scale with
visible chunks. The larger synthetic case demonstrates roughly seven times less
pan callback time, not support for exporting that map from a real game yet.

The fixture JSON measured 9.1 MB and 36.7 MB respectively. JSON transfer/parse
remains a first-load cost. The larger model exceeds the current 24 MiB export
budget, so increasing the actual export caps is deliberately outside this PR.

### Next work before larger real exports

Keep the current 2,048 chunks / 80,000 objects / 24 MiB validation and one-GiB
isolated helper guard. The exporter still copies/loads the save, enumerates and
sorts every charted chunk before truncation, queries entities it later discards,
and uses sequential 16-chunk batches. It also maintains a seen-object table past
the output cap. Those game-side costs were not measured by this browser harness.

The next focused step should combine a compact/versioned payload (deduplicated
prototype strings/colors or tiled delivery) with disposable native Factorio
measurements of export time, helper peak memory and payload size. Measure native
entity filtering and bounded chunk selection there before increasing caps.
Consider progressively fetched tiles or background parsing only after profiling
the resulting first load. Preserve enemy priority, modded extents, source
identity and old snapshot readers. Enemy/rail-dominated scenes may need different
LOD treatment; the resource/building benchmark does not establish their throughput.

To repeat the browser measurement, run
`node panel/test/map-render-benchmark.mjs v0.3.19-alpha`, open
`http://127.0.0.1:41740/` and choose **Run measurements**. The same harness at
`/legacy/` uses the exact baseline renderer modules from Git. Keep the browser,
viewport, device-pixel ratio and object mix the same; alternate run order when
collecting more samples. The harness replaces its canvas and controls between
runs so old event handlers cannot contaminate the comparison. The 320,000-object
case intentionally tests renderer capacity beyond the supported export payload.

## One-shot offline export

The exporter now loads the copied save once with Factorio's benchmark runner.
It exports in a callback intercepted before the first simulation update, writes
one map and a job-matched completion receipt, then exits. No multiplayer listener,
RCON connection or repeated container command is needed. The saved mod selection
is preserved: adding an exporter mod would trigger configuration-change callbacks.
Instead, instrumentation is installed into `base` only in the worker's private
engine/data copy; bundled image files remain read-only. The debug hook is removed before
collection. Debug access is enabled only for that network-isolated worker.

The worker retains its one-GiB memory budget and low CPU priority. It operates on
private copies, never writes the source save, and publishes only after map and
completion-receipt validation. A failed or incomplete export retains the previous
map. Its phase timings are recorded privately in `map-export-metrics.json` so
copy/load/export/decode costs can be measured independently on larger fixtures.

Chunk selection uses a bounded nearest-chunk heap instead of sorting every
charted chunk. Only the selected 2,048 entries are sorted, with deterministic
equal-distance ties. Rejected objects no longer grow the deduplication table
past the output budget, and repeated entities reuse prototype colors. Bounds and
recipes remain per entity, preserving rotations and modded extents. Terrain,
enemy priority, the 80,000-object cap and the version-1 map contract are unchanged.
This supersedes the sequential-RCON and full-sort descriptions above.

### Native acceptance scope

`Factorio offline export acceptance` runs on fresh GitHub-hosted Linux runners.
It downloads checksum-verified Factorio 2.0.77 and 2.1.23 and generates its own
fixture saves. Both versions use `--benchmark`; neither offers `--test-save`.
Tests compare saved tick/mod state before simulation, unchanged source hashes,
scenario callback replacement and failure without a completion receipt. A second
job exercises the real bundled-image wrapper and the read-only installed-runtime
overlay on a fresh Docker engine. It never connects to a deployment.

A playerless headless force does not complete chart requests. The native test
therefore checks the unmodified production visibility path with zero charted
chunks, then explicitly supplies a test-only explored-region adapter for exact
native tile/entity output comparison against paused-server extraction. Lua
fixtures separately verify chart filtering, nearest selection and category
budgets. This is not native validation of a real-player charted save or a claim
that larger worlds fit the helper budget. No existing worlds are used.

Further work remains measuring engine-side entity filtering and private runtime
copy costs on representative disposable worlds. Larger caps require those
measurements. Compact payload delivery follows separately; rollback readers
continue to receive version-1 snapshots.

## Compact snapshot delivery

Map storage remains `map.json` version 1. New clients negotiate `compact-v1` on
`/map`; older clients and controllers continue to use the original response.
The negotiated response contains small revision/scope/pin/status metadata. A
separate `/map-payload` request retrieves the static snapshot as an explicit gzip
file containing the `goblin-map/1` wire format. Repeated entity details share a
prototype dictionary; rows retain exact coordinates, per-entity bounds, amounts,
recipes, order and optional fields. Terrain RLE and renderer inputs are unchanged.

The controller lazily encodes/compresses once per snapshot and retains one bounded
byte buffer, with concurrent requests coalesced. It retains no additional parsed
entity graph. Snapshots nobody views incur no encoding/compression cost. Pins,
players and status do not invalidate these bytes. Atomic map replacement changes
the revision; a request cannot associate older payload bytes with a new revision.
No map fetch starts a Factorio process or requests a save.

The gzip file uses a distinct media type, without HTTP content-encoding, so Node
fetch, ordinary proxies and the pinned HTTP/2 host connection transport identical
bytes. The same server-scoped map-view permission applies at both endpoints.
Clients bound both transferred and decompressed bytes to 32 MiB and reject invalid
row/dictionary references. An unavailable decoder, interrupted payload or concurrent
export falls back to the original JSON route. Authentication failures keep their
normal sign-in/access handling. No new persisted files, schema, dependencies or
image pins are needed; rollback readers see the original map.

### Synthetic payload measurement

Run `node panel/test/map-payload-benchmark.mjs` with Node 24. The fixture has 80,000
objects across resources, buildings, rails and enemies, with 2,048 uniform chunks,
fractional coordinates, amounts and recipes. Seven measured passes follow two
warmups; case order alternates. A local run on October 30, 2026 measured:

| Representation | Bytes |
| --- | ---: |
| Original JSON | 12,249,894 |
| Compact dictionary JSON | 2,450,655 |
| Compact gzip file | 503,019 |
| Original JSON with gzip, for comparison | 641,517 |

The delivered file is about 96% smaller than uncompressed JSON and 22% smaller
than gzipped original JSON. Node parsing took 37.7 ms for the original, versus
21.0 ms for gzip decompression, parsing and expansion. First-time encoding plus
compression cost 174 ms; later viewers reuse those bytes. A separate Chromium
check of the same fixture measured 28.3 ms versus 16.5 ms median decode work and
rendered all 80,000 objects on desktop/mobile. These are synthetic CPU/byte
measurements, not network latency, GPU time, gameplay or larger-export acceptance.
Current export caps and the one-GiB offline worker budget remain unchanged.

Regression coverage checks exact round trips including rotations/unknown fields,
empty maps, zero/null optional fields, corrupt/oversized payloads, snapshot races,
compression coalescing, scoped permissions, session expiry and byte preservation
through HTTP and the pinned HTTP/2 agent. Browser fixtures exercise compact
snapshot reuse, legacy large/modded-map rendering and fallback after a corrupted
payload or missing decoder. All previews use in-memory synthetic data only.
