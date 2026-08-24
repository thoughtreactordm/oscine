---
taskId: 01M0TDPGQG2BFA5MT5SN4XE4HR
title: 'Main: unified search.query + library.recentlyAddedAlbums'
status: in-review
priority: high
labels:
  - main
  - search
  - library
  - D23
  - D25
workstream: W13
workstreamId: W13-4
dependsOn:
  - 01M0TDNEXM17131MG55E72K2EK
  - 01M0TDNVBPBXZCA5WH3G70JSSM
order: 3
created: '2026-08-24T17:39:39.887Z'
updated: '2026-08-24T19:06:59.288Z'
---
Spec: wiki `fermata-quick-access` → D23, D25, Data contract, RQ1/RQ2.

The heaviest main card. One channel that returns grouped, ranked results across all **local** entity types, plus the recent-albums query.

**`src/main/search/` (new).** `search.query(SearchQuery) → SearchResult`:
- Tracks reuse `tracks_fts` (migration 004). Do not build a second track index.
- Albums, artists, playlists get lightweight indexing — FTS or an indexed `LIKE` over what are, next to 100k tracks, small sets.
- "Shows" = the operator's **subscribed** podcasts, matched locally. Do NOT reach Apple's catalogue (that stays behind `podcasts.searchCatalog` in W9 Discover — D23/D14).
- `mode` from the prefix scopes to one group; `blended` returns all. Per-group cap = `limitPerGroup`. Omit empty groups; group order is the D21 category order. `score` is stable within a group (RQ2 — per-group caps and prefixes are the mitigation, not global normalization).

**`library.recentlyAddedAlbums({ limit }) → AlbumCard[]`.** Albums ordered by `MAX(indexed_at)` over their tracks, desc. `addedAt` is that max.

**Tests** (`tests/main/`): blended query returns each populated group capped and in category order; a prefixed query returns only its group; a subscribed-show match appears, a non-subscribed catalogue show does not; recent-albums orders by max `indexed_at` and a rescan of an old album does not resurface it (leans on W13-2); a ~100k-track synthetic timing for `search.query` written down (a miss is a card, not a silent cap).

**Done when:** one call returns correctly grouped/ranked results across the five local kinds, and recent albums reflect true arrival order.
