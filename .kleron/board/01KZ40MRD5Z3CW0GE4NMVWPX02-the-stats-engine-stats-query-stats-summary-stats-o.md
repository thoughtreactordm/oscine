---
taskId: 01KZ40MRD5Z3CW0GE4NMVWPX02
title: 'The stats engine — `stats.query`, `stats.summary`, `stats.overTime`'
status: in-review
priority: high
labels:
  - main
  - ipc
  - stats
workstream: W10
workstreamId: W10-10
dependsOn:
  - 01KZ40JCB1BTE51EE841D51FJ1
order: 1
created: '2026-08-03T14:32:31.396Z'
updated: '2026-08-03T21:27:11.556Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → The stats engine.

Every statistic Fermata reports is **one shape**: filter `listens` by a time range, group by a dimension, order by count or by summed `ms_listened`. Build that once.

**Four dimensions** — `track`, `album`, `artist`, `genre`. The first three group on the **snapshot columns** on `listens`; genre groups through `listen_genres.genre_key`.

**Group on the snapshot, not on a join to `artists`/`albums`.** Two reasons and both matter: a deleted track's history still counts (D17), and correcting a tag next year does not silently rewrite what last year said. The cost is that a genuine tag *fix* leaves the same artist in the list twice under two spellings — a recorded debt, not something to solve here by joining.

**Two totals, both reported, neither chosen for the operator:** listens (rows) and time (summed `ms_listened`). For a library mixing three-minute songs with hour-long mixes they tell different stories, and picking one would be picking a side.

**IPC** (starting in `src/shared/ipc.ts`):
- `stats.query({ range, dimension, limit, offset })` → ranked rows with both totals. **One channel, four dimensions** — not four near-identical channels.
- `stats.summary({ range })` → the dashboard's headline numbers.
- `stats.overTime({ range, bucket })` → a bucketed series.

`range` should be a closed `{ from, to }` in UTC ms rather than a named preset, with the presets resolved in the renderer. A main process that knows what "this year" means is a main process that has to know the operator's timezone and their idea of when a year starts.

Every result carries a `trackId` where one survives, so the dashboard's rows can click through to the library — and `null` where the track is gone, which the UI must render rather than crash on.

**Tests** (`tests/main/`): a generated log of ~100k listens across a few thousand tracks and several years — assert correct counts and sums per dimension, correct boundary behaviour (a listen exactly on `from`, exactly on `to`), rows with `track_id IS NULL` still counted, a multi-genre listen counted once per genre and not once overall, and that every query stays inside a sensible time budget on that fixture. That last assertion is what tells you whether the deliberately-absent rollup indexes need to exist.

**Done when:** the queries are correct, tested against a large generated fixture, and measured — with the measurement written down, because migration 013 defers its index decision to exactly this number.
