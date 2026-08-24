---
title: Fermata — Quick Access (Command Palette & Quick Menu)
created: '2026-08-24T17:38:20.208Z'
updated: '2026-08-24T17:38:20.208Z'
---
Status: **specified, unbuilt** · Owns **D21–D27** · New workstream **W13 Quick Access** · Migration **016** · Delivers the `tracks.indexed_at` column W12 recorded-debt #1 sketched

# Fermata — Quick Access

## Why this document exists

Two features, one substrate. A **command palette** — Nuxt UI `UCommandPalette` in a modal, opened
from anywhere — that fuzzy-finds any view, any album/playlist/artist/track/show, and runs the top
actions (play, queue, play next, jump to a setting, download the latest episode of a podcast). And a
**Quick Menu** — an off-canvas `UDrawer` on the Now Playing screen — holding three short computed
lists: Favorite Playlists, Recent Additions, and Favorite Artists.

They share three new pieces of foundation, which is why they are one workstream and not two:

1. A **unified search surface** — today only `tracks` are indexed (`tracks_fts`); the palette needs
   albums, artists, playlists and subscribed shows to be findable too.
2. **Favorites beyond tracks.** Track favorites are D18's `track_favorites` (heart). Playlists and
   artists get a **star**, on new per-entity tables that mirror it. The Quick Menu is their face.
3. An **arrival clock.** "Recent Additions" needs a real first-seen timestamp; `tracks` has none.
   This is exactly the `tracks.indexed_at` column W12's recorded-debt #1 already sketched.

Two existing decisions sit next to this and must not be quietly stepped on.

**D18** made favorites a table of truth with the "My Favorites" pinned playlist as its face, and its
revisit trigger is *"a second system-owned collection appears (Recently Added, Most Played)."* The
Quick Menu's Recent Additions list **names that trigger**. It does not fire it, for the same reason
D20's Discover shelves do not: it is a computed, ephemeral drawer list, recomputed on open, not
pinned to a rail and not saved. The argument is made explicit under Amendments so the next person
does not fire the trigger by accident.

**W8** records that a keyboard-shortcut subsystem is *"currently homeless and needs a home before
remapping can be offered."* This workstream introduces the app's **first** global shortcut
(Ctrl/Cmd+K). It does so with a deliberately minimal handler that W8 can later absorb — not a rival
subsystem. D27 draws that line.

---

## What is already there

Verified in the tree rather than remembered:

- **Favorites is track-only and non-polymorphic.** Migration 015 is `track_favorites(track_id
  INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE, favorited_at INTEGER NOT NULL)` plus
  `idx_track_favorites_at`. `src/shared/favorites.ts` has no entity-type union; every request/result
  is track-id shaped. The renderer's `artistFavorites.ts` store is **not** artist-favoriting — it is
  *"favorite tracks by this artist,"* seeded from a track's `artist_id`. So both playlist favorites
  and true artist favorites are genuinely new.
- **Search indexes only tracks.** Migration 004 builds FTS5 `tracks_fts(title, artist, album)` with a
  trigram tokenizer and four triggers that keep it synced to `tracks`. Track search runs through
  `library.listTracks` (`searchText` → `tracks_fts MATCH`). Podcast search is `podcasts.searchCatalog`
  against Apple's remote catalogue. Albums, artists, playlists have **no** standalone search surface.
- **The shell is vue-router + `useShellStore`.** `AppShell.vue` is the single root; global modals mount
  there (precedent: `<NewPlaylistModal />`). Tabs (`src/renderer/shell/routes.ts`): `library`,
  `curate`, `podcasts`, `listening`, `now-playing`, `settings`. `useShellStore.setActiveTab(name,
  index)` switches the active view.
- **`settingsNav.reveal(key, { changed })` already exists** (W8) — it jumps the Settings view to a
  single setting by key, expanding sections and setting the search query. This is the palette's
  "jump to a setting" mechanism; the palette does not reinvent it.
- **W8's settings registry is declarative** (`src/shared/settings.ts`): every key carries label, help,
  and **search keywords**. The palette's `/` settings mode reads that registry; it does not maintain a
  second list of settings.
- **No global keyboard handling exists.** The only keydown listener outside a text control is
  `PaneResizer.vue`. There is no registry, no `useGlobalShortcuts`.
- **`tracks` has no arrival column.** Columns are `id, root_id, rel_path, mtime, size, duration_ms,
  codec, sample_rate, channels, bit_depth, title, artist_id, album_id, track_no, disc_no, rg_*,
  play_count, last_played_at, rating`. `mtime` is the file's mtime and the incremental-rescan key — a
  lie if read as "recently added." `albums` is a real table with `id`, `artwork_hash`, `year` and no
  timestamp of its own.
- **Playback is not IPC.** Audio lives in the renderer (invariant). "Play album/playlist/next/queue"
  are renderer store gestures (`playback.ts`, `queueCommands.ts`, `tunedeck.ts`), the same activation
  path Library and Discover use. Only data reads and podcast downloads cross IPC.
- **Podcast downloads are W9.** Downloading the latest episode of a subscribed show is an existing W9
  IPC surface; the palette dispatches to it and lets the Podcasts panel own the progress.

---

## Decisions

These land in `fermata-design` §2 verbatim.

### D21 — Command palette: one blended, prefixed modal as the universal entry point

The palette is a single `UCommandPalette` inside a modal, mounted globally in `AppShell.vue`, opened
by **Ctrl/Cmd+K** and by a **visible search affordance in the title bar**, dismissed by Esc. Free text
fuzzy-matches everything and results render **grouped by category** (Views, Albums, Artists,
Playlists, Tracks, Shows, Actions, Settings). Typed **prefixes narrow the mode**: `>` actions, `@`
artists, `#` playlists, `/` settings. The whole surface is reachable from here — navigation, entity
search, actions, and settings.

*Rejected*: separate palettes per mode (the point is one keystroke to anything); navigation-only in
v1 (the operator asked for play/queue/download from the palette, and the action layer is most of the
value); a permanently visible omnibar consuming shell chrome (the title-bar affordance opens the modal
— it does not become a second always-live search box).

*Accepted cost*: one modal must render heterogeneous groups from a mix of synchronous (navigation,
actions, settings) and asynchronous (`search.query`) sources without stutter. That is RQ1.

*Revisit when*: grouped async rendering with prefix modes cannot hold frame budget against a 100k
library — then the entity groups get windowing or a tighter per-group cap (RQ1).

### D22 — The palette is stateless; actions fire-and-forget with a toast

Selecting an action dispatches it and dismisses the palette. A toast confirms. Anything ongoing — a
podcast download, a long enqueue — reports progress in its **owning panel** (downloads in the Podcasts
view), not in the palette. The palette holds no task state across dismissals.

*Rejected*: inline progress inside the palette (couples a transient finder to long-lived task state);
silent fire (the operator cannot tell a mis-click from a no-op).

*Revisit when*: an action has no owning surface to report into — then either that surface is built
first, or the action does not belong in the palette yet.

### D23 — Search is one unified `search.query` channel, grouped and ranked in main

A single IPC channel returns results across all local entity types, already grouped and ranked.
Tracks reuse `tracks_fts`. Albums, artists and playlists get lightweight indexing (FTS or an indexed
`LIKE` over what are, next to 100k tracks, small sets). "Shows" means the operator's **subscribed**
podcasts, matched locally — **not** Apple's catalogue, which stays behind `podcasts.searchCatalog` in
the W9 Discover pane.

*Rejected*: per-entity queries merged and ranked in the renderer (splits ranking across the wire, and
each new type is another round-trip to wire and debounce); reaching Apple's catalogue from the palette
(D14 keeps the network out of the local finder; catalogue search has its own home).

*Accepted cost*: main owns a second ranking surface besides Library's list query. Cross-type ranking
is genuinely hard (RQ2) and is bounded by per-group caps and by the prefixes, which let a power user
bypass blended ranking entirely.

*Revisit when*: blended ranking buries the obvious answer often enough to need per-type score
normalization, or a new searchable type appears.

### D24 — Favorites extends to playlists and artists via per-entity tables, denoted by a star

Playlists and artists become favoritable on **new per-entity tables** — `playlist_favorites` and
`artist_favorites` — each mirroring `track_favorites` exactly (entity id as `PRIMARY KEY` with
`ON DELETE CASCADE`, plus `favorited_at INTEGER NOT NULL` and its index). The **star** glyph denotes a
favorited playlist or artist; the **heart** stays tracks-only. This preserves D18's per-entity design
rather than replacing it.

*Rejected*: a polymorphic `favorites(entity_type, entity_id, favorited_at)` table that migrates the
track hearts into it (reworks D18's shipped `track_favorites`, its FTS-adjacent list paths, and three
renderer stores, for a generality two more tables do not need); reusing the track heart's pinned-
playlist face for playlists/artists (their face is the Quick Menu — D26).

*Accepted cost*: a fourth favoritable type would mean a fourth table rather than a row's worth of enum.
That is the same bet D18 already made and won.

*Revisit when*: a fourth favoritable type arrives — at that point generalizing may finally pay for
itself, and the three tables migrate together.

### D25 — `tracks.indexed_at` is the arrival clock; the scanner stamps it on insert only

A new `tracks.indexed_at` (`INTEGER NOT NULL`, UTC ms) is **stamped on `INSERT`** and **never touched
by the `(root_id, rel_path)` upsert** — a rescan is not an arrival. Existing rows backfill at migration
time from `roots.added_at`, falling back to a single `nowMs` for rows whose root has none. "Recent
Additions" orders albums by `MAX(indexed_at)` over their tracks; a track list orders by `indexed_at`
directly. `mtime` stays the rescan key and is never read as arrival.

This is the exact column **W12 recorded-debt #1** sketched, and the column **D18's "Recently Added"**
would read. W13 delivers it; W12 may later add a "Just arrived" Discover recipe on top of it for free.

*Rejected*: ordering by `mtime` (the file clock — a re-tag or a rescan reorders "recent" wrongly, the
precise failure the Discover doc called out).

*Accepted cost*: a schema migration that touches the scan path and backfills every existing row. On a
large library the backfill is a one-time cost (RQ3), and pre-existing rows share whatever `roots.added_at`
resolution exists — honest, if coarse, for libraries indexed before this column existed.

*Revisit when*: — (the column is the durable answer; nothing above it forces a change).

### D26 — Quick Menu: a Now-Playing-scoped, left-side drawer of three computed lists

The Quick Menu is a `UDrawer` off-canvas from the **left**, triggered from the Now Playing screen, and
scoped to it. It holds three short lists: **Favorite Playlists** (star), **Recent Additions** (recent
albums by `indexed_at`), **Favorite Artists** (star). Each list is a computed convenience view,
recomputed when the drawer opens; none is a pinned rail fixture and none is a saved collection.
Selecting an item navigates to or plays it and closes the drawer.

*Rejected*: a global drawer (it would fight a possibly-open Tunedeck on the right — the operator chose
the left edge precisely to stay clear of it); making Recent Additions a persistent, system-owned rail
fixture (that is D18's actual trigger — D26 is a transient list, not a collection).

*Accepted cost*: three lists that overlap conceptually with Discover and the Library. They are a
**shortcut**, not a second Discover: no recipes, no ranking beyond recency/`favorited_at`, capped
short, and they do not import the Discover pane, the dashboard, or Library facets. Panels stay islands.

*Revisit when*: the operator wants one of these lists pinned as a durable collection — that is D18's
trigger firing on purpose, and a different feature.

### D27 — The global shortcut is a minimal handler, a placeholder for W8's subsystem

Introducing Ctrl/Cmd+K requires the app's first global keyboard handling. It ships as a **single,
minimal registration seam** — one composable that binds Ctrl/Cmd+K to toggle the palette and Esc to
close it, guarded so it does not fire while a text input is focused. It is **not** a remappable
keyboard-shortcut subsystem. When W8 builds that subsystem, this handler is **absorbed into it**, not
extended in place.

*Rejected*: building the remappable subsystem now (it is W8's, has its own registry and settings
surface, and would balloon this workstream); scattering a raw `keydown` listener with no seam (leaves
W8 nothing to absorb and invites collisions).

*Accepted cost*: for one release there is one hard-coded global shortcut with no remap UI (RQ4).

*Revisit when*: W8 picks up the keyboard-shortcut subsystem — this handler is the first thing it
subsumes.

---

## Amendments to existing decisions

Landed in `fermata-design` with this specification.

### D18 — the trigger has not fired

Add under D18's revisit trigger, alongside the existing D20 note:

> *Note (D26)*: the Quick Menu's Recent Additions and Favorite lists are not this trigger. They are
> computed drawer lists, recomputed on open, not pinned to a rail, and not saved. "My Favorites"
> remains the sole system-owned *collection*. Playlist and artist favorites (D24) are tables of truth
> in the same spirit as `track_favorites`, faced by the drawer rather than by a pinned playlist.

### W12 recorded-debt #1 — retired

`tracks.indexed_at` (D25) is the column that debt sketched. Once migration 016 lands, W12's "Just
arrived" recipe is unblocked; the debt note is retired with a pointer to D25.

---

## Product rules

Rules a piece that is sensible in isolation can still break.

1. **The palette dispatches; owning surfaces own state.** No long-lived task lives in the modal (D22).
2. **Prefixes bypass blended ranking.** `@`, `#`, `>`, `/` scope to one group so a power user never
   fights cross-type scoring. Blended (no prefix) is the discovery path; prefixed is the precision path.
3. **Search is local.** The palette never reaches the network. Subscribed shows are matched locally;
   the Apple catalogue stays in W9 Discover (D23, D14).
4. **Settings come from the registry.** The `/` mode enumerates W8's `settings.ts` keys and their
   keywords. Simple keys (boolean, enum) toggle inline with a toast; anything richer calls
   `settingsNav.reveal(key)` and closes the palette (the "inline for simple, jump for complex" split).
5. **Actions reuse existing paths.** Play/queue/play-next call the same renderer activation the Library
   and Discover use — no second play-order builder. Download-latest calls the W9 IPC — no second
   downloader.
6. **Star is playlists and artists; heart is tracks.** Never the same glyph for both. The star toggles
   `playlist_favorites` / `artist_favorites`; the heart still toggles `track_favorites`.
7. **`indexed_at` is arrival, `mtime` is rescan.** Never read `mtime` as arrival; never write
   `indexed_at` on the upsert.
8. **Quick Menu lists are short and computed.** Capped, recency/`favorited_at`-ordered, recomputed on
   open, never pinned. They are shortcuts, not a Discover.
9. **Panels stay islands.** The palette and the drawer do not import each other, the Tunedeck, the
   dashboard, or Library facets. They call stores and IPC, not sibling components.

---

## Data contract

Migration **016**. The contract starts in `src/shared`, as every surface does.

### Schema (migration 016)

```sql
CREATE TABLE playlist_favorites (
  playlist_id INTEGER PRIMARY KEY REFERENCES playlists(id) ON DELETE CASCADE,
  favorited_at INTEGER NOT NULL
);
CREATE INDEX idx_playlist_favorites_at ON playlist_favorites(favorited_at);

CREATE TABLE artist_favorites (
  artist_id INTEGER PRIMARY KEY REFERENCES artists(id) ON DELETE CASCADE,
  favorited_at INTEGER NOT NULL
);
CREATE INDEX idx_artist_favorites_at ON artist_favorites(favorited_at);

-- Arrival clock. Added nullable, backfilled, then treated as NOT NULL by the writer.
-- (SQLite cannot ALTER ADD a NOT NULL column without a constant default; backfill, then enforce
--  in the insert path rather than rewriting the table.)
ALTER TABLE tracks ADD COLUMN indexed_at INTEGER;
UPDATE tracks SET indexed_at = COALESCE(
  (SELECT roots.added_at FROM roots WHERE roots.id = tracks.root_id),
  <migration nowMs>
) WHERE indexed_at IS NULL;
CREATE INDEX idx_tracks_indexed_at ON tracks(indexed_at);
```

The scanner sets `indexed_at = nowMs` on first insert of a `(root_id, rel_path)` and **omits it from
the upsert's `UPDATE` set**. Confirm the exact NOT NULL enforcement against the migration house style
(002/004/015) at implementation time — the invariant is *stamped once, never on rescan*, however the
column's nullability is finally expressed.

### `src/shared/search.ts` (new)

```ts
export type SearchEntityKind = 'view' | 'album' | 'artist' | 'playlist' | 'track' | 'show'
export type SearchMode = 'blended' | 'action' | 'artist' | 'playlist' | 'setting'  // from the prefix

export interface SearchQuery {
  readonly text: string
  readonly mode: SearchMode          // parsed from the leading prefix by the renderer
  readonly limitPerGroup: number
}

export interface SearchHit {
  readonly kind: SearchEntityKind
  readonly id: number                // entity id (albumId/artistId/playlistId/trackId); views/shows carry their own id space
  readonly title: string
  readonly subtitle: string | null   // "12 tracks", artist name, etc.
  readonly artworkHash: string | null
  readonly score: number             // main's ranking, for stable ordering within a group
}

export interface SearchGroup {
  readonly kind: SearchEntityKind
  readonly hits: SearchHit[]         // capped at limitPerGroup
}

export interface SearchResult {
  readonly groups: SearchGroup[]     // omit empty groups; order is the D21 category order
}
```

### `src/shared/favorites.ts` (extend)

Mirror the existing track shapes for two new entity types — toggle, state (batch), list:

```ts
export interface TogglePlaylistFavoriteRequest { readonly playlistId: number }
export interface PlaylistFavoriteStateRequest  { readonly playlistIds: readonly number[] }
export interface PlaylistFavoriteStateResult   { readonly favoritedIds: number[] }
export interface ListFavoritePlaylistsQuery    { readonly limit: number }
export interface ListFavoritePlaylistsResult   { readonly playlists: Playlist[] }

export interface ToggleArtistFavoriteRequest   { readonly artistId: number }
export interface ArtistFavoriteStateRequest    { readonly artistIds: readonly number[] }
export interface ArtistFavoriteStateResult     { readonly favoritedIds: number[] }
export interface ListFavoriteArtistsQuery      { readonly limit: number }
export interface ListFavoriteArtistsResult     { readonly artists: FavoriteArtist[] }  // id, name, artworkHash|null
```

### `src/shared` — recent additions

A lean album-card shape for the drawer (there is no `Album` type in `src/shared` today; add one here or
reuse the `DiscoverAlbumItem` fields — pick one and keep it):

```ts
export interface AlbumCard {
  readonly albumId: number
  readonly title: string
  readonly artist: string | null
  readonly year: number | null
  readonly artworkHash: string | null
  readonly addedAt: number          // MAX(indexed_at) over the album's tracks
}
```

### IPC channels (`src/shared/ipc.ts`)

Following the existing `'channel': { request; response }` pattern; final names aligned to the
`favorites.*` convention already in the file:

```
search.query:                { request: SearchQuery;                response: SearchResult }
favorites.togglePlaylist:    { request: TogglePlaylistFavoriteRequest; response: PlaylistFavoriteStateResult }
favorites.playlistState:     { request: PlaylistFavoriteStateRequest;  response: PlaylistFavoriteStateResult }
favorites.listPlaylists:     { request: ListFavoritePlaylistsQuery;    response: ListFavoritePlaylistsResult }
favorites.toggleArtist:      { request: ToggleArtistFavoriteRequest;   response: ArtistFavoriteStateResult }
favorites.artistState:       { request: ArtistFavoriteStateRequest;    response: ArtistFavoriteStateResult }
favorites.listArtists:       { request: ListFavoriteArtistsQuery;      response: ListFavoriteArtistsResult }
library.recentlyAddedAlbums: { request: { limit: number };             response: AlbumCard[] }
```

No `palette.run` channel and no `queue.*` channel: actions are renderer gestures (D-invariant: audio
and the queue live in the renderer). The palette's action layer calls renderer stores and, for
downloads, the existing W9 IPC.

---

## Renderer architecture

- **`useGlobalShortcuts` (new, minimal, D27).** One composable, mounted once in `AppShell.vue`, binding
  Ctrl/Cmd+K → toggle palette, Esc → close, guarded against firing inside focused text controls. The
  seam W8 later absorbs.
- **`CommandPalette.vue`.** `UModal` + `UCommandPalette`, mounted in `AppShell.vue` next to
  `NewPlaylistModal`. Parses the leading prefix into a `SearchMode`, debounces `search.query` for
  entity groups, and merges in the synchronous Navigation / Actions / Settings groups. Title-bar
  affordance lives in `AppTitleBar.vue` and opens the same modal.
- **Command registry.** A declarative list of commands — `{ id, label, icon, group, keywords, run }`.
  Navigation commands call `useShellStore.setActiveTab` (and the router for deep targets like a
  specific playlist). Action commands call the renderer queue/playback stores (play, queue, play next)
  and, for download-latest, the W9 podcasts IPC. Settings commands are generated from W8's
  `settings.ts` registry: boolean/enum keys toggle inline with a toast; the rest call
  `settingsNav.reveal(key)`.
- **Favorite stars.** `usePlaylistFavorites` and a *real* `useArtistFavorites` store (distinct from the
  existing track-by-artist `artistFavorites.ts`), plus a shared `FavoriteStar` toggle placed on the
  playlist rail / contents and on the artist surface.
- **`QuickMenu.vue`.** A left-edge `UDrawer` triggered from `NowPlaying.vue`, rendering three lists
  from `favorites.listPlaylists`, `library.recentlyAddedAlbums`, and `favorites.listArtists`. Item
  activation reuses existing navigation/activation and closes the drawer.

---

## Risks

- **RQ1 — `UCommandPalette` at scale, unverified.** Grouped results from mixed sync/async sources, with
  prefix modes and a 100k-track library behind the entity groups, on this Nuxt UI version. Echoes R4
  (Nuxt UI standalone). *Mitigate*: a spike inside W13-5 before the UI is committed; per-group caps;
  fall back to windowing the entity groups if frame budget slips.
- **RQ2 — cross-entity ranking quality.** A fuzzy track match and an exact playlist-name match do not
  share a score scale; naive blending buries the obvious answer. *Mitigate*: per-group caps so no group
  drowns another; prefixes as the precision escape hatch; tune against a fixture library.
- **RQ3 — `indexed_at` backfill cost and honesty.** The migration backfills every existing row, and
  pre-existing rows inherit `roots.added_at`'s resolution rather than a true arrival instant.
  *Mitigate*: backfill in one `UPDATE`; document that arrival before this column is approximate; the
  going-forward stamp is exact.
- **RQ4 — global shortcut collisions.** Ctrl/Cmd+K against focused inputs, Electron accelerators, and
  the OS, with no remap UI until W8. *Mitigate*: the focus guard in `useGlobalShortcuts`; keep it a
  single documented binding until W8's subsystem owns it.

---

## Card breakdown

Workstream **W13 Quick Access**, depends on **W2** (library, scanner, FTS), **W4** (shell, token
layer), **W8** (settings registry + `settingsNav`), **W10** (D18 favorites pattern), and integrates
**W5** (queue/play activation) and **W9** (podcast downloads). Eight cards.

| Id | Card | Depends | Notes |
|---|---|---|---|
| W13-1 | Shared contracts: `search.ts`, favorites extensions, `AlbumCard`, all IPC channels | — | Types and channel registration only; no handlers behind them. The foundation card. |
| W13-2 | Migration 016 + scanner `indexed_at` | W13-1 | Two favorite tables, `tracks.indexed_at`, backfill, indexes; scanner stamps on insert and never on upsert. Retires W12 debt #1. Tests: insert stamps, upsert does not, backfill, cascade delete. |
| W13-3 | Main: favorites service for playlists & artists | W13-1, W13-2 | Extend `src/main/favorites/{service,store}.ts` with toggle/state/list for both types; wire handlers. Tests. |
| W13-4 | Main: unified `search.query` + `library.recentlyAddedAlbums` | W13-1, W13-2 | New `src/main/search/`; reuse `tracks_fts`, lightweight-index albums/artists/playlists, match subscribed shows locally; rank + group; recent-albums query over `indexed_at`. Tests incl. a 100k timing note (a miss is a card, not a silent cap). |
| W13-5 | Renderer: `useGlobalShortcuts` + palette shell + title-bar affordance | W13-1, W13-4 | RQ1 spike lives here. `CommandPalette.vue` renders entity groups from `search.query` plus Navigation; prefix parsing; Ctrl/Cmd+K + Esc + title-bar button. |
| W13-6 | Renderer: command / action / settings registry | W13-5, W13-3 | Navigation, actions (play/queue/play-next via renderer stores; download-latest via W9 IPC), settings (inline toggle for simple keys, `settingsNav.reveal` for the rest, from W8's registry), toasts (D22). |
| W13-7 | Renderer: favorite stars + playlist/artist favorite stores | W13-1, W13-3 | `usePlaylistFavorites`, real `useArtistFavorites`, `FavoriteStar` on the playlist rail/contents and the artist surface. |
| W13-8 | Renderer: Quick Menu `UDrawer` on Now Playing | W13-7, W13-4 | Left-edge drawer, three lists, activation reuse, recompute on open. |

W13-1 is load-bearing; everything imports it. W13-4 is the heaviest main card and owns RQ1's data side;
W13-5 owns RQ1's UI side. W13-6 must not build a second play-order builder or a second downloader.
W13-8 must not import the Discover pane, the dashboard, or Library facets — panels stay islands.

---

## Explicitly not W13

| Idea | Why not |
|---|---|
| Remappable keyboard-shortcut subsystem | W8's, homeless by its own admission. D27 ships one binding as a seam W8 absorbs. |
| Apple catalogue search in the palette | D23/D14. The palette is local; catalogue search is W9 Discover. |
| Polymorphic favorites table | D24 keeps D18's per-entity pattern; generalize only when a fourth type arrives. |
| "Just arrived" Discover recipe | W12's, unblocked by D25's `indexed_at` but not built here. |
| Inline task progress in the palette | D22. Owning panels own progress. |
| A global (non-Now-Playing) Quick Menu | D26. Left-edge, Now-Playing-scoped, to stay clear of the Tunedeck. |
| Actions with side effects beyond play/queue/download in v1 | Scope guard; the registry is declarative, so more commands are additive later. |
