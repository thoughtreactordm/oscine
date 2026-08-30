---
taskId: 01M19YTSGMFHTJJ9WV5GBD3W93
title: 'Discover: era/decade exploration shelf (day-picked year)'
status: todo
priority: high
labels:
  - discover
  - recipe
workstream: W12
workstreamId: W12-7
dependsOn:
  - 01M19YT6AYCKGZV5KNHNG7PGCY
order: 0
created: '2026-08-30T18:27:42.228Z'
updated: '2026-08-30T18:33:29.570Z'
---
## Intent

A Discover shelf built purely on release year — the most listening-independent "relationship between
the songs themselves." Day-hash picks a year (or a decade) present in the library and surfaces albums
from it. Depends on the genre-roulette card (W12-6) for the shared day-seed pick primitive, the
`DiscoverRecipeId` extension pattern, and the exclusion-order/placement decision.

## Design fit (does not reopen D20)

- Same sanctioned-freshness argument as W12-6: selection is by UTC-day hash, deterministic within a
  day, rotating nightly — not per-open `RANDOM()`. D20 intact.
- `fermata-discover-1-0`'s "Explicitly not 1.0" rejects *time-of-day / "Saturday morning"* shelves,
  but an era/decade shelf is a different axis (`albums.year`, not `listens.started_at`) and is not on
  that reject list. New category, not a reopened decision.
- No schema change: `albums.year` (migration 001) is populated. Zero reads of `listens` — works at
  cold start by construction.

## Recipe behaviour

- Candidate pool: years (or decades — decide in build) that have ≥ `SHELF_MIN_ITEMS` albums of
  ≥ `ALBUM_MIN_TRACKS` tracks and a non-null `year`. Pick one by the W12-6 day primitive.
  Decade vs single-year is a copy/curation call — a sparse library favours decades, a dense one
  favours years; pick one rule and record it.
- Grain: album. Reuse `toAlbumItem`. Rank within the era by the day tie-break; cap `SHELF_ITEM_CAP`
  (10), target `SHELF_ITEM_TARGET` (8), omit below `SHELF_MIN_ITEMS` (3). Respect `claimed`.
- Dynamic title carrying the era (copy TBD), e.g. "1994, all at once" / "Deep in the '80s".
  One *why* per card (e.g. `Unplayed · N tracks`), no second title.

## Files

- `src/shared/discover.ts` — add `'era'` (or `'decade'`) to `DiscoverRecipeId`.
- `src/main/library/discover/recipes/era.ts` — new recipe (pattern: `guestAppearances.ts` /
  `neglectedGenre.ts`).
- `src/main/library/discover/compose.ts` — register in `RECIPES` + `EXCLUSION_ORDER`, using the
  placement convention W12-6 settles.
- Renderer: generic pane + `saveShelf`; **verify** dynamic title only, no component change.

## Tests (`tests/main/`)

- Same library + same `dayKey` → same era + same shelf; different `dayKey` → rotates.
- Cold start still produces a shelf.
- Albums with null `year` never appear; era below `SHELF_MIN_ITEMS` → shelf omitted.

## Out of scope

No network, no `listens`/`started_at` time-of-day logic, no `tracks.rating`, no shuffle control, no
renderer windowing.
