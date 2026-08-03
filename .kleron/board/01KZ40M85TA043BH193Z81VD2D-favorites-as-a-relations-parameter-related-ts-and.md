---
taskId: 01KZ40M85TA043BH193Z81VD2D
title: >-
  Favorites as a relations parameter — `related.ts` and the artist nexus
  annotation
status: todo
priority: low
labels:
  - main
  - tunedeck
  - W7-adjacent
  - D18
workstream: W10
workstreamId: W10-9
dependsOn:
  - 01KZ40K4S52HJ267CZEWGD7QH1
order: 51
created: '2026-08-03T14:32:14.778Z'
updated: '2026-08-03T14:32:14.778Z'
---
Spec: wiki `fermata-listening-and-scrobbling` → Favorites → "As a relations parameter".

Two separate things, both making favorites a signal rather than just a list.

**1. `src/main/library/related.ts`.** Its six seed-track queries grow an optional `favoritesOnly` filter and an optional favorite-weighting in their ordering, so "more from this artist" and "same genre" can prefer tracks the operator has hearted. Optional and off by default — the existing callers must keep their current results exactly, and there should be a test that says so.

Weighting, not filtering, is the interesting mode: a related pane that shows *only* favorites is a much narrower thing than one that surfaces them first and then fills out with the rest. Prefer a stable ordering (favorite desc, then whatever the query already ordered by) over a score, because a score invites tuning and there is nothing here to tune it against.

**2. The artist nexus annotation.** When W7's nexus resolves similar artists from MusicBrainz, annotate each with how many favorites the operator holds for it. That is the "favorites for a similar artist" signal: **computed locally against a remote list**, so no favorite ever leaves the machine and the annotation is present even when the similar-artist list came from cache with the network down.

This card depends on W7's nexus existing for part 2. If it does not yet, land part 1 and split part 2 out rather than blocking.

**Done when:** a related pane with weighting on puts hearted tracks first without dropping anything it showed before, and the nexus shows a favorites count against similar artists offline.
