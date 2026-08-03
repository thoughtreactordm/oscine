---
taskId: 01KZ40JR89PBK931CC7W55QFMT
title: >-
  `play_count` and `last_played_at` as maintained caches — and
  `stats.rebuildCounters`
status: in-review
priority: medium
labels:
  - main
  - D11
  - D17
workstream: W10
workstreamId: W10-5
dependsOn:
  - 01KZ40JCB1BTE51EE841D51FJ1
order: 3
created: '2026-08-03T14:31:25.705Z'
updated: '2026-08-03T18:54:23.594Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → The listen event → "play_count is a maintained cache".

Migration 001 created `tracks.play_count` and `tracks.last_played_at`. They have been deliberately unwritten ever since, and `src/shared/history.ts` says why in full. **This is the card that owns them** — update that comment as part of this work rather than leaving it contradicting the code.

They become **maintained caches of the `listens` log, not counters in their own right.** That distinction is not pedantry: D11's amendment names it as the exact revisit trigger — *"when a card makes `tracks.play_count` derived from `play_history` rather than a counter in its own right"* — and W10-13 depends on it being true.

**`stats.rebuildCounters`** recomputes both columns for every track by full aggregation over `listens`, joined on `track_id`. Run it:
- after a D11 import (W10-13)
- after any migration that touches `listens`
- on demand from Settings, as a repair action

**If the cache and the log ever disagree, the log wins, without argument.** Say so in the code.

Once the columns are real, expose them: sortable `Plays` and `Last played` columns in `TrackList.vue` via the existing column chooser, off by default.

**Tests** (`tests/main/`): `rebuildCounters` reproduces incrementally-maintained values exactly over a generated log of a few thousand listens across a few hundred tracks; a track whose listens all have `track_id IS NULL` gets `play_count = 0` rather than being skipped or erroring; rebuilding twice is idempotent; rebuilding over an empty log zeroes everything rather than leaving stale values.

**Done when:** sorting the library by Plays reflects real listening, and `rebuildCounters` on a populated database is a no-op.
