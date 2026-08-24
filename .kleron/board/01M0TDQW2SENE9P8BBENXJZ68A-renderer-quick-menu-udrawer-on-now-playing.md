---
taskId: 01M0TDQW2SENE9P8BBENXJZ68A
title: 'Renderer: Quick Menu UDrawer on Now Playing'
status: in-progress
priority: medium
labels:
  - renderer
  - ui
  - now-playing
  - D26
workstream: W13
workstreamId: W13-8
dependsOn:
  - 01M0TDQ6N6PMEF2JK32C0JGP32
  - 01M0TDPGQG2BFA5MT5SN4XE4HR
order: 0
created: '2026-08-24T17:40:24.280Z'
updated: '2026-08-24T20:48:08.878Z'
---
Spec: wiki `fermata-quick-access` → D26, Renderer architecture, product rules 8/9.

The Quick Menu drawer on the Now Playing screen.

**`QuickMenu.vue`.** A `UDrawer` off-canvas from the **left**, triggered from `NowPlaying.vue` (left-side to stay clear of a possibly-open Tunedeck on the right — D26). Three short lists, each recomputed when the drawer opens:
- **Favorite Playlists** — `favorites.listPlaylists` (star, from W13-7's store).
- **Recent Additions** — `library.recentlyAddedAlbums` (recent albums by `indexed_at`, from W13-4).
- **Favorite Artists** — `favorites.listArtists` (star).

Each list is short and capped; ordering is recency / `favorited_at` only — **no recipes, no ranking** (product rule 8). Selecting an item reuses the existing navigation/activation path and closes the drawer.

**Islands (product rule 9).** Do NOT import the Discover pane, the Listening dashboard, the Tunedeck, or Library facets. Token layer only; artwork through the existing `fermata:` thumbnail path.

**Tests** (`tests/renderer/`): the drawer opens from the left on the Now Playing screen; the three lists populate from their channels; opening again after a favorite toggle / a new import reflects the change; selecting an item navigates/plays and closes the drawer.

**Done when:** Now Playing has a left-edge drawer with the three lists, each live and each a one-click way into a playlist, a recent album, or an artist.
