---
taskId: 01M1A2HWRC5E6GCF0DHZB25PE5
title: >-
  Discover: denormalize track_genres.album_id to retire genre-roulette's library
  scan
status: in-progress
priority: low
labels:
  - discover
  - perf
  - recipe
workstream: W12
workstreamId: W12-8
order: 2
created: '2026-08-30T19:32:44.940Z'
updated: '2026-08-30T21:18:50.875Z'
---
## Intent

`genre-roulette` (W12-6) picks the day's genre from a library-wide candidate pool, which forces a
per-compose scan correlating `track_genres` → `tracks` to recover each genre row's `album_id`. Every
other recipe is taste- or claim-scoped and pays nothing like it. At the 100k-track scale target this
scan is ~35 ms and pushed `compose` p95 from ~225 ms to ~260 ms, just over the old 250 ms tab-open
budget. W12-6 bumped the `composeScale` budget to 300 ms and left this card as the "number to beat"
(the scale test's own docstring anticipates this: a miss is a rollup card, not a `RANDOM() LIMIT 10`).

## Why a pure index can't fix it

The cost is a cross-table correlation: `track_genres(track_id, genre_key)` has no `album_id`, so the
pool must join `tracks` by `track_id` to bucket genres by album. Both sides are already optimally
indexed by `track_id`; no index over existing columns removes the 100k-row correlation.

## The fix

Denormalize `album_id` onto `track_genres` and add a covering index `(genre_key, album_id)`. Then:

- Pool gate becomes a pure covering-index walk (`GROUP BY genre_key … COUNT(DISTINCT album_id)`), no
  `tracks` join.
- `albumsInGenre`'s `genre_albums` CTE reads `track_genres` directly by `genre_key`.

Estimated ~30 ms → ~5 ms, back well under 250 ms.

## Keeping it in sync (the reason this is its own card)

Three sites set `tracks.album_id`:

- `store.ts:1237` — the scan's delete-then-insert of `track_genres`, where `albumId` is already in
  scope. Trivial: add the column to `insertTrackGenre`.
- `store.ts:2004` / `store.ts:2075` — `applyOverride` / `revertOverride` (W16 write-back) update
  `tracks.album_id` **without** touching `track_genres`. These would desync a denormalized column.

Cleanest sync is a schema-owned trigger `AFTER UPDATE OF album_id ON tracks` that mirrors
`NEW.album_id` into `track_genres`, so no scattered application code has to remember. The migration
is: `ALTER TABLE track_genres ADD COLUMN album_id`; backfill from `tracks`; the covering index; the
trigger. `track_genres` is `WITHOUT ROWID` — `ADD COLUMN` and the backfill are supported.

## Files

- New migration under `src/main/db/migrations/` (column + backfill + index + trigger).
- `src/main/library/store.ts` — `insertTrackGenre` gains `album_id`; pass `albumId` at the call site.
- `src/main/library/discover/recipes/genreRoulette.ts` — `fillableGenreKeys` and `albumsInGenre`
  read the denormalized column; drop the `tracks` correlation.
- `tests/main/library/discover/composeScale.test.ts` — restore the 250 ms budget once this lands.

## Out of scope

Behavior is unchanged — this is purely the read path getting cheaper. No change to which genre a
given day picks, to exclusion order, or to the display-order decoupling W12-6 introduced.
