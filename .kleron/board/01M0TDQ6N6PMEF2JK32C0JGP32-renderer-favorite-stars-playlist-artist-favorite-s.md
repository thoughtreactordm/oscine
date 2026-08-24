---
taskId: 01M0TDQ6N6PMEF2JK32C0JGP32
title: 'Renderer: favorite stars + playlist/artist favorite stores'
status: in-review
priority: medium
labels:
  - renderer
  - ui
  - favorites
  - D24
workstream: W13
workstreamId: W13-6
dependsOn:
  - 01M0TDNEXM17131MG55E72K2EK
  - 01M0TDP6QRS7EBP62F7ZG38R4P
order: 5
created: '2026-08-24T17:40:02.341Z'
updated: '2026-08-24T20:13:01.281Z'
---
Spec: wiki `fermata-quick-access` → D24, Renderer architecture, product rule 6.

The star UI for playlists and artists, and the stores behind it.

**Stores.** `usePlaylistFavorites` and a **real** `useArtistFavorites` — the latter is distinct from the existing `artistFavorites.ts`, which is "favorite tracks by this artist" (a different thing) and must not be repurposed. Each wraps the W13-3 channels (`favorites.togglePlaylist`/`playlistState`/`listPlaylists`, `favorites.toggleArtist`/`artistState`/`listArtists`) with optimistic toggle + batch state hydration, following the pattern of the existing track `favorites.ts` store.

**`FavoriteStar` component.** A shared star toggle (mirror the heart's `FavoriteHeart`/`nowPlayingMark` pattern). **Star for playlists and artists; the heart stays tracks-only — never the same glyph for both** (product rule 6). Place it on the playlist rail / playlist contents header, and on the artist surface (StageView / the Tunedeck artist pane).

**Tests** (`tests/renderer/`): toggling a star calls the right channel and flips optimistically; batch `state` hydrates stars for a list; the star glyph is used for playlist/artist and the heart is untouched for tracks.

**Done when:** a playlist and an artist can be starred/unstarred from their surfaces, state survives a reload, and tracks still use the heart.
