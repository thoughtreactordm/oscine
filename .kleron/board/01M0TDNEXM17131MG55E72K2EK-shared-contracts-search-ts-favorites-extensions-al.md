---
taskId: 01M0TDNEXM17131MG55E72K2EK
title: 'Shared contracts: search.ts, favorites extensions, AlbumCard, IPC channels'
status: done
priority: high
labels:
  - shared
  - ipc
  - D21
  - D23
  - D24
  - D25
workstream: W13
workstreamId: W13-1
order: 1
created: '2026-08-24T17:39:05.267Z'
updated: '2026-08-25T21:17:15.088Z'
---
Spec: wiki `fermata-quick-access` → Data contract.

The cross-process contract starts in `src/shared`, like every other surface. This card is types and channel registration only — no handlers behind them yet.

**`src/shared/search.ts` (new).** `SearchEntityKind` (`view | album | artist | playlist | track | show`), `SearchMode` (`blended | action | artist | playlist | setting`), `SearchQuery { text, mode, limitPerGroup }`, `SearchHit { kind, id, title, subtitle, artworkHash, score }`, `SearchGroup { kind, hits }`, `SearchResult { groups }` (empty groups omitted; order is the D21 category order).

**`src/shared/favorites.ts` (extend).** Mirror the existing track shapes for two new entity types — toggle, batch state, list — for playlists and artists: `TogglePlaylistFavoriteRequest`, `PlaylistFavoriteStateRequest/Result`, `ListFavoritePlaylistsQuery/Result` (returns `Playlist[]`); `ToggleArtistFavoriteRequest`, `ArtistFavoriteStateRequest/Result`, `ListFavoriteArtistsQuery/Result` (returns a `FavoriteArtist` = id, name, artworkHash|null). Do not touch the shipped track shapes.

**Recent additions type.** Add a lean `AlbumCard { albumId, title, artist, year, artworkHash, addedAt }` (there is no `Album` type in `src/shared` today — add one here or reuse `DiscoverAlbumItem`'s fields; pick one and keep it).

**Channels (`src/shared/ipc.ts`),** following the existing `'channel': { request; response }` pattern; align final names to the `favorites.*` convention already in the file:
- `search.query`
- `favorites.togglePlaylist` / `favorites.playlistState` / `favorites.listPlaylists`
- `favorites.toggleArtist` / `favorites.artistState` / `favorites.listArtists`
- `library.recentlyAddedAlbums` (`{ limit }` → `AlbumCard[]`)

No `palette.run` and no `queue.*` channel: actions are renderer gestures (audio and the queue live in the renderer). Handlers may throw "not implemented" until later cards; the contract compiling and preload exposing it is this card.

**Done when:** main, preload and renderer import the same types; the channels are in the IPC map; `npm run typecheck` is clean.
