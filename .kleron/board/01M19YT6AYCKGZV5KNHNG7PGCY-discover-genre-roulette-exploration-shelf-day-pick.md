---
taskId: 01M19YT6AYCKGZV5KNHNG7PGCY
title: 'Discover: genre-roulette exploration shelf (day-picked genre)'
status: in-progress
priority: high
labels:
  - discover
  - recipe
workstream: W12
workstreamId: W12-6
order: 0
created: '2026-08-30T18:27:22.590Z'
updated: '2026-08-30T18:33:28.169Z'
---
## Intent

A Discover shelf that surfaces one genre per UTC day, picked by hashing the day rather than by
listening taste — the "timely, feels-random, but explainable" freshness the operator asked for.
Today the nine recipes only use the day-hash as a *tie-break* (`tieBreak(recipeId, entityId, day)`),
so daily rotation is nearly invisible. This recipe promotes the day-hash to the **primary selector**.

## Design fit (does not reopen D20)

- D20 rejected `RANDOM()` on tab-open; the sanctioned freshness knob is the UTC day
  ("Same library + same log + same UTC date → same shelves"). Selecting a genre by day-hash honours
  that exactly: deterministic within a day, rotates at midnight UTC, every card keeps a one-line *why*.
- `fermata-discover-1-0`'s "Explicitly not 1.0" list rejects *shuffle-this-shelf* and *time-of-day*
  shelves but does **not** reject a genre-exploration shelf. This is a new category, not a reopened
  decision. No schema change: reads `track_genres` ∪ the W15 user-tag layer, same casefold key the
  existing recipes use.
- Distinct from `neglected-genre`: that one is taste-scored (top-10 library genre that is *not* a
  top-5 recent-listen genre) and gated on a non-empty seed. Genre-roulette is **not** taste-gated,
  works at cold start, and can pick any genre with enough albums to fill a shelf.

## Shared plumbing (this card owns it; W12-era depends on it)

1. **Day-seeded pick primitive** in `src/main/library/discover/hash.ts` — a deterministic
   "pick one of N by day" helper reusing `fnv1a`, e.g. hash each candidate key with `dayKey` and
   take the min. Rotates nightly, stable within a day. This is the selection analogue of the existing
   tie-break; treat the hash function as part of the recipe contract and test it (changing it
   reshuffles the day's pick).
2. **`DiscoverRecipeId` union** — add `'genre-roulette'` in `src/shared/discover.ts` (the one
   cross-process contract) so preload/renderer/main stay in sync.
3. **Exclusion-order placement decision.** Default: append after `revisit` in `EXCLUSION_ORDER`
   (`compose.ts`) so exploration claims albums *last* and never poaches a taste shelf. **Open
   question to resolve in build:** the operator wanted exploration to feel *prominent*, but display
   order currently equals compute/exclusion order in `compose()`. If prominence is wanted, decouple
   display order from claim order (small change: claim last, render earlier). Pick one and record it.

## Recipe behaviour

- Genre pool: distinct genre keys (file genres ∪ user tags) whose library has ≥ `SHELF_MIN_ITEMS`
  albums of ≥ `ALBUM_MIN_TRACKS` tracks, so a picked genre can actually fill a shelf. Pick one by the
  day primitive.
- Grain: album (mirror `neglected-genre`'s row shape and `toAlbumItem`). Rank within the genre by the
  day tie-break (no taste score needed); cap at `SHELF_ITEM_CAP` (10), target `SHELF_ITEM_TARGET` (8),
  omit below `SHELF_MIN_ITEMS` (3).
- Dynamic title carrying the genre (final copy TBD in build), e.g. "Tonight's crate: {Genre}".
  One *why* per card (e.g. `Unplayed · N tracks` / `M of N played`), no second title.
- Respects `claimed` (skip albums earlier shelves took).

## Files

- `src/shared/discover.ts` — extend `DiscoverRecipeId`.
- `src/main/library/discover/hash.ts` — day-pick primitive.
- `src/main/library/discover/recipes/genreRoulette.ts` — new recipe (pattern: `neglectedGenre.ts`).
- `src/main/library/discover/compose.ts` — register in `RECIPES` + `EXCLUSION_ORDER`.
- Renderer: `DiscoverPane.vue` already renders dynamic titles and generic shelves; `saveShelf` is
  generic. **Verify** no renderer change is needed beyond copy — panels stay islands, token layer only.

## Tests (`tests/main/`)

- Same library + same `dayKey` → same genre and same shelf; different `dayKey` → rotates.
- Cold start (zero listens) still produces a shelf (the non-taste-gated property).
- Omitted when no genre can fill `SHELF_MIN_ITEMS`.
- Determinism of the day-pick primitive (contract test, like the tie-break test).

## Out of scope

No network, no `play_history`, no `tracks.rating`, no per-open randomness or shuffle control, no new
renderer windowing. `/`-splitting genre misfires are inherited from W10-1, not fixed here.
