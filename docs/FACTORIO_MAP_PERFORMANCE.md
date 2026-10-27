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
The browser still paints every visible object at overview zoom. Larger export
limits should follow disposable Factorio measurements of helper peak memory,
export duration, JSON size/parse cost and mobile frame timing at representative
density. Useful subsequent work is bounded overview aggregation and measuring
engine-side entity filtering or batch size, with modded-object and enemy-priority
fixtures. A browser index microbenchmark alone is insufficient evidence to raise
the export limits.
