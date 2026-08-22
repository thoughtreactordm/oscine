---
taskId: 01M0N55P8K3JVM7YXCSKZ5P27V
title: 'Recipe engine — seed, hash, compose, and the four placeholder recipes'
status: in-progress
priority: high
labels:
  - main
  - library
  - D20
workstream: W12
workstreamId: W12-2
dependsOn:
  - 01M0N554FR56WRJ0B85AES6HF1
order: 1
created: '2026-08-22T16:34:27.730Z'
updated: '2026-08-22T16:46:24.412Z'
---
Spec: wiki `fermata-discover-1-0` → Constants, Freshness, Exclusion order, recipes 1–4, Engine shape, Testing.

The load-bearing card. Build the engine so the four placeholder shelves have real rows.

**Shape.** `src/main/library/discover/` — `constants.ts`, `seed.ts` (taste seed + window widening), `hash.ts` (UTC day-key + tie-break), `compose.ts` (exclusion order, omit-thin, memo key), `recipes/forYou.ts`, `unplayed.ts`, `revisit.ts`, `artists.ts`.

Each recipe is `(db, nowMs, claimed, seed) → items`. Clock is injected. Do not call `stats.query`. Do not import `related.ts`. Do not use `RANDOM()` or `play_history`.

**The four.**
- `for-you` — unplayed/underplayed albums from the recent-listen seed, excluding `HEAVY_MS` rotation. Drop on empty seed.
- `unplayed` — complete albums, every track `play_count = 0`, sampled not dumped. Cold start may render below `SHELF_MIN_ITEMS`.
- `revisit` — albums with `play_count` 1–3 and max `last_played_at` older than 90 days.
- `artists` — pick one album-artist from the deep-catalog tail; title is `Deeper into {name}`. Local discography only.

**Memo.** Cache against `(max listens.id, favorites generation, track count, UTC dayKey)`. Same inputs → byte-identical `DiscoverShelvesResult`.

**Tests** (`tests/main/library/discover/`): the generated-library cases in the spec for these four; exclusion (`for-you` album absent from `unplayed`); cold start (only `unplayed`); day-stability; 100k-ish timing written down.

**Done when:** `compose` returns the four shelves against the fixture for the reasons the spec names, and a second call with the same `nowMs` is identical.
