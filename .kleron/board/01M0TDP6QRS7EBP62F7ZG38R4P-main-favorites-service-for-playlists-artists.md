---
taskId: 01M0TDP6QRS7EBP62F7ZG38R4P
title: 'Main: favorites service for playlists & artists'
status: in-review
priority: medium
labels:
  - main
  - favorites
  - D24
workstream: W13
workstreamId: W13-3
dependsOn:
  - 01M0TDNEXM17131MG55E72K2EK
  - 01M0TDNVBPBXZCA5WH3G70JSSM
order: 2
created: '2026-08-24T17:39:29.656Z'
updated: '2026-08-24T18:47:42.165Z'
---
Spec: wiki `fermata-quick-access` → D24, Data contract (IPC channels).

Extend the existing favorites service to the two new entity types and wire their handlers. Mirror the shipped track methods (`toggle` / `state` / `list`) rather than inventing a new shape.

**`src/main/favorites/{service,store}.ts`.** Add, for playlists: `togglePlaylist(playlistId)`, `playlistState(playlistIds[])`, `listPlaylists(limit)` (returns `Playlist[]`, `favorited_at` desc). For artists: `toggleArtist(artistId)`, `artistState(artistIds[])`, `listArtists(limit)` (returns `FavoriteArtist` = id, name, artworkHash|null, `favorited_at` desc). Reads/writes go to `playlist_favorites` / `artist_favorites` from migration 016.

**Handlers.** Wire the six `favorites.*` channels from W13-1 to these methods. The star is a UI concern — the service just owns the tables.

**Tests** (`tests/main/`): toggle is idempotent-per-entity (second toggle removes); `state` returns exactly the favorited subset of a batch; `list` orders by `favorited_at` desc and respects `limit`; deleting the underlying playlist/artist drops it from the list (cascade from W13-2).

**Done when:** the six channels round-trip against a real DB, and track favorites are untouched.
