---
title: Oscine — Discover 1.0
created: '2026-08-22T16:33:05.332Z'
updated: '2026-08-22T16:33:05.332Z'
---
Status: **specified, unbuilt** · Owns **D20** · D20, the D18 note, and the §8/§9 rows are already in `fermata-design` · No migration in 1.0

# Oscine — Discover 1.0

## Why this document exists

Curate's Discover pane already describes the product on its face. Four named shelves, a wall of artwork, a promise that nothing here phones anywhere, and a note that a shelf can become a playlist once the rows are real. That is the 1.0 target: **5 to 10 artists, albums, or songs per deterministic category**, drawn only from the library and the listens log.

Two existing decisions sit next to this and must not be quietly stepped on.

**D14** keeps the network out of Discover. Podcast Discover already reaches Apple on tab open, and that is recorded debt against W7-6. Music Discover has no such excuse: the catalogue is folders on disk, and the pane copy has already told the operator that nothing here phones anywhere. Similar-artists from MusicBrainz is a Tunedeck / M7 pane, not a Discover shelf.

**D18**'s revisit trigger is *"a second system-owned collection appears (Recently Added, Most Played)"*. Discover shelves look like that if they are pinned to the rail. They are not. They are ephemeral recipes. Conversion to a playlist is an explicit save, which produces an ordinary D12 row. This document is the argument that the trigger has **not** fired, so that the next person does not fire it by accident.

The Listening dashboard (W10-12) answers a different question — *what have I been listening to* — and a Wrapped retrospective (W10-14) is a third. Discover is **forward**: what to play next from files already owned. A recipe that only reprints `stats.query` does not belong here.

---

## What is already there

Verified in the tree rather than remembered:

- **`DiscoverPane.vue`** is a permanent pane, not a scaffold. Four placeholder shelves with ids `for-you`, `unplayed`, `revisit`, `artists`; six skeleton slots each; a Placeholder badge on the header; per-shelf horizontal scroll. The file says the commit that gives a shelf real rows is the commit that has to virtualize it. This spec answers that: the query is capped at 10, so the strip never becomes the 100k-track list the invariant is about. A "see all unplayed" is a Library filter, not an unbounded Discover scroller, and it is not in 1.0.
- **W10 is in.** `listens`, `listen_genres`, `track_genres`, `play_count` / `last_played_at` as caches of the log, `track_favorites`, `stats.query`. That is enough for every 1.0 recipe.
- **`src/main/library/related.ts`** exposes six related-content strands off a *seed track*, with `FavoriteBias` (`ignore | prefer | only`). Discover is library-wide, not seed-track-shaped. Steal ranking ideas (identity before neighbourhood, `prefer` reorders and does not narrow). Do not call `buildRelated` as the page.
- **`play_history`** is a 500-row trail, skips included, excluded from D11. It answers jump-back. It is not a Discover input.
- **`tracks.rating`** exists and is unwritten in the UI. No ratings shelf.
- **`tracks` has no first-seen column.** Upsert on `(root_id, rel_path)` does not stamp one. `mtime` is the file's mtime, the incremental rescan key, and a lie if used as "recently added". "Just arrived" is out of 1.0 for this reason; the schema is sketched under Recorded debts so it is not re-derived later.
- **`playlists.create`** and **`playlists.addTracks`** already exist. Save-as-playlist is those two, not a third write path.
- **Podcast Discover** is a different pane (`PodcastDiscoverPane.vue`) against Apple's catalogue. This document does not touch it.

---

## The decision

This lands in `fermata-design` §2 verbatim.

### D20 — Discover: **named local recipes, not a model and not a fixture**

Discover is a page of **named SQL recipes** over the local library and the `listens` log. Each recipe produces at most ten playable items of one grain (album or track), with a one-line *why*, and is omitted when it cannot fill a minimum. The same library, the same log, and the same UTC day produce the same shelves. Nothing is fetched. Nothing is inferred beyond the tags and the listens. A shelf is not a playlist until the operator saves it as one.

*Rejected*: a learned model, embedding space, or collaborative filter (the catalogue is one person's folders; there is no other user to collaborate with, and a model that cannot be explained is a shelf the operator cannot trust); calling MusicBrainz similar-artists (D14, and the pane already promised it phones nowhere); reprinting `stats.query` (that is the Listening dashboard, which faces backward); pinning shelves to the Curate rail as D18 fixtures (fires a revisit trigger this feature does not need; save-as-playlist is the conversion); `RANDOM()` on every tab open (reshuffles the wall and makes "why is this here" unanswerable); mixed artist/album/track cards on one scroller in 1.0 (two card shapes and two play actions on a strip that is already asking the operator to browse).

*Accepted cost*: a library with no listens sees only the recipes that do not need a taste seed, which is a thinner page and the honest one. A recipe cannot recommend a file that is not in the library, which is the whole point and also the ceiling.

*Revisit when*: a recipe needs a signal the schema does not have (first-seen, skip rate, a written rating), or the operator wants a shelf that is a live collection rather than a daily proposal. The first is a migration and a new recipe; the second is D18's trigger actually firing.

---

## Amendments to existing decisions

Landed in `fermata-design` with this specification.

### D18 — the trigger has not fired

The note under D18's revisit trigger:

> *Note (D20)*: Discover shelves are not this trigger. They are ephemeral recipes, recomputed, not pinned to the rail, and they become a playlist only when the operator saves one. "My Favorites" remains the sole system-owned collection. Recently Added is still the example that would fire this, and it is out of Discover 1.0 because `tracks` has no first-seen column.

### §8 and §9

W12 is in the workstream table. Discover is noted as off the milestone ladder, distinct from Podcast Discover.

---

## Product rules

These are the rules a recipe that is clever in isolation can still break.

1. **Forward, not backward.** Discover proposes the next listen. The dashboard reports the last one. Heavy rotation, top tracks, top artists as a ranked list — those stay on the dashboard.
2. **Playable identity, not snapshot identity.** The dashboard groups `listens` on snapshot columns so last year does not rewrite. Discover joins `listens.track_id` to the live `tracks` / `artists` / `albums` / `track_genres` rows, and drops listens whose `track_id` is NULL. A recommendation you cannot play is a broken row, the same reason D18 cascades favorites on delete. Tag fixes therefore *improve* Discover and *do not* rewrite the dashboard. That divergence is load-bearing, not an accident.
3. **Deterministic per UTC day.** Same library + same log + same UTC date → same shelves. Ties break on a hash of `(recipeId, entityId, dayKey)`, not on `RANDOM()`. A later "shuffle this shelf" bumps a salt; 1.0 has no such control.
4. **One grain per shelf.** 1.0 grains are `album` and `track`. Artist is a *selector* inside a recipe (which discography, which favorite) and a *title*, not a third card type. Artist portraits do not exist locally without D14.
5. **One *why* per card.** The shelf hint is the recipe; the card subtitle is the specific reason ("Unplayed · 12 tracks", "Last played 11 months ago", "3 of 10 played"). Do not invent a second title.
6. **Cross-shelf exclusion, in listed order.** An album (or track) that lands on an earlier shelf is ineligible for a later one. Recipes that pick an artist also claim that artist against later artist-picking recipes. Compute sequentially; do not score globally.
7. **Hide thin shelves.** Fewer than `SHELF_MIN_ITEMS` items → omit the shelf, same as `related.ts` dropping empty strands. Exception: cold-start `unplayed` may show fewer, because it may be the only shelf.
8. **No network, no trail, no ratings.** `play_history`, `tracks.rating`, MusicBrainz, Apple, Last.fm loved — out. Favorites are local and already in.
9. **Save is a snapshot.** The playlist is an ordinary D12 row. Editing it later does not edit the recipe; reopening Discover tomorrow does not edit the playlist.

---

## Constants

Clock is injected as `nowMs`. Tests pass a fixture instant; production passes `Date.now()`. Every window is derived from these, not from named SQL date functions, so a main process does not have to know the operator's timezone. Day-key is the UTC calendar date of `nowMs`.

| Name | Value | Role |
|---|---|---|
| `SHELF_ITEM_CAP` | 10 | Hard query/display cap |
| `SHELF_ITEM_TARGET` | 8 | Aim for this; fill to cap if the recipe has more of equal quality |
| `SHELF_MIN_ITEMS` | 3 | Omit the shelf below this |
| `RECENT_MS` | 30 days | Taste-seed window |
| `RECENT_FALLBACK_MS` | 90 days | If the 30-day seed has fewer than `SEED_MIN_ARTISTS` distinct artists |
| `SEED_MIN_ARTISTS` | 3 | Widen the window rather than recommend from one artist |
| `HEAVY_MS` | 7 days | "Currently in rotation" — excluded from *for-you* |
| `REVISIT_AGE_MS` | 90 days | "A long time ago" |
| `REVISIT_PLAY_MAX` | 3 | Played, but not a habit |
| `ALBUM_MIN_TRACKS` | 4 | Singles and one-file folders do not fill album shelves |
| `DEEP_MIN_ALBUMS` | 3 | A discography, not an EP |
| `DEEP_TOP_N` | 15 | Candidate artists, by all-time listen time among playable tracks |
| `NEGLECTED_LIBRARY_N` | 10 | Largest genres in the library by track count |
| `NEGLECTED_LISTEN_N` | 5 | Genres in the recent-seed top, which are *not* neglected |

There is no operator-facing setting for these in 1.0. They are named so a later card can expose them rather than so this one must.

---

## Freshness and cache

`discover.shelves` is a pure function of `(nowMs, library, listens, favorites)`. Main memoizes the last result against:

```
(max listens.id, favorites generation, track count, UTC dayKey)
```

Invalidate on listen commit, favorite toggle, and scan complete. Opening the Discover tab on the same day with no new listens is a cache hit, not six queries. The renderer does not compute recipes and does not hold a stale copy across those events — it refetches, and main answers from the memo.

Tie-break hash: a stable 32-bit mix of `recipeId`, entity id, and `dayKey`. Used only to order equal scores. Changing the hash function reshuffles a day's ties; treat it as part of the recipe contract and test it.

---

## Exclusion order

Compute in this order. Each recipe receives the album ids, track ids, and artist ids already claimed.

1. `for-you`
2. `artists` (deep in an artist)
3. `almost-finished`
4. `forgotten-favorites`
5. `because-favorited`
6. `guest-appearances`
7. `unplayed`
8. `neglected-genre`
9. `revisit`

`revisit` is last so it cannot steal an album that is also "almost finished" or "forgotten". `unplayed` sits after the taste-shaped shelves so the remainder is genuinely the rest of the library, not a second copy of *for-you*.

---

## The 1.0 catalog

Nine recipes. The first four are the placeholder ids, unchanged, so the pane can fill the skeletons in place. The next five are the local-library extras that do not duplicate the dashboard. Dynamic titles are allowed, and are required where the placeholder heading would otherwise be generic.

Grain `album` unless noted. Album cards use `albums.artwork_hash`. Track cards use the parent album's artwork; no artwork is a token-coloured vinyl, the same empty the placeholder already draws.

### 1. `for-you` — Built for you

*Hint:* From what you have been playing.

**Seed.** Distinct `artist_id` (track performer, falling back to album artist) ranked by summed `ms_listened` over `RECENT_MS`, widening to `RECENT_FALLBACK_MS` then all-time until `SEED_MIN_ARTISTS` is met or the log is exhausted. Same for `genre_key` via `track_genres` on those playable listens. If the seed is empty, **drop the shelf** (cold start).

**Candidates.** Complete-enough albums (`ALBUM_MIN_TRACKS`) whose album artist or a majority of tracks sit in the artist seed, or that share a seeded `genre_key`, and that are **not** in heavy rotation: no track on the album has `last_played_at` within `HEAVY_MS`.

**Prefer, in order:** unplayed complete albums (`play_count = 0` on every track) by seed artists; then underplayed albums by seed artists (album has at least one unplayed track); then unplayed albums in seed genres. `FavoriteBias: prefer` — hearted tracks on an album float it without dropping anything the cap would have shown, same contract as `related.ts`.

**Exclude** anything listened in `HEAVY_MS`. This is what stops the shelf reprinting the dashboard.

**Title** stays "Built for you".

### 2. `unplayed` — Sitting unplayed

*Hint:* In your library, never heard.

**Filter.** Albums of at least `ALBUM_MIN_TRACKS` tracks where **every** track has `play_count = 0`.

**Rank.** Artists in the taste seed first (same seed as `for-you`, empty seed → no artist boost), then seed genres, then everyone else. Inside a tier, day-hash. This is a sample, not a dump: a 100k library's unplayed set is most of the library.

**Cold start.** This shelf *is* Discover. It may render below `SHELF_MIN_ITEMS` if that is all there is. Diversity of `genre_key` / artist beats clustering on the first artist in the table.

### 3. `revisit` — Worth revisiting

*Hint:* Played once, a long time ago.

**Filter.** Albums of at least `ALBUM_MIN_TRACKS` where every track has `play_count` between 1 and `REVISIT_PLAY_MAX` inclusive, and the album's most recent `last_played_at` is older than `REVISIT_AGE_MS`. (Using the max of the tracks, not the min: one recently replayed track means the album is not forgotten.)

**Prefer** albums with a high fraction of tracks that have at least one listen — you finished it, or nearly, once — over an album you sampled a single file from.

**Drop** if the library is younger than `REVISIT_AGE_MS` of listening, or if nothing qualifies.

"Played" means a D17 listen. Do not consult `play_history`.

### 4. `artists` — Deep in an artist

*Hint:* Where the tail of a discography is.

**Pick one artist.** Among the `DEEP_TOP_N` artists by all-time listen time (playable listens), those with at least `DEEP_MIN_ALBUMS` albums credited to them as **album artist** (the discography, not guest appearances). Score `listen_ms * unplayed_album_fraction`. Highest wins. Unplayed album = every track `play_count = 0`.

**Show** that artist's unplayed albums, `year` ascending so the tail includes the early records as well as the late ones (unknown year last), studio credits before albums whose performing-artist set is mixed.

**Title is dynamic:** `Deeper into {artist.name}`. The placeholder heading is the recipe; the heading the operator sees names the artist. If the pick is empty, drop the shelf — do not fall back to a generic "Deep in an artist" over random albums.

**Local discography only.** Not MusicBrainz similar-artists, not "complete this artist" against a remote release-group list. Files on disk.

Claims that artist against `because-favorited`.

### 5. `almost-finished` — Almost finished

*Hint:* You started these.

**Filter.** Albums of at least `ALBUM_MIN_TRACKS` with at least one track `play_count > 0` and at least one track `play_count = 0`.

**Prefer** higher completion fraction (played tracks / track count), then more recent `last_played_at` among the played side — you are more likely to finish something from last month than from five years ago, and the five-year case is `revisit`'s job.

**Subtitle:** `{played} of {total} played`.

This is the recipe a streaming service cannot honestly offer, because the rest of the album may not be in the catalogue. It is the first extra on purpose.

### 6. `forgotten-favorites` — Forgotten favorites

*Hint:* You hearted these.

**Grain: track.**

**Filter.** Rows in `track_favorites` whose track has `play_count = 0`, or `last_played_at` older than `REVISIT_AGE_MS`.

**Rank.** Oldest `last_played_at` first (NULLs first — hearted and never listened is the loudest miss), then oldest `favorited_at`.

**Subtitle:** `Hearted · never played` or `Hearted · last played {relative}`.

Drop if there are no favorites, or none are cold. Empty favorites is a normal state, not an error; omitting the shelf is the empty state.

### 7. `because-favorited` — Because you favorited {artist}

*Hint:* More from an artist you heart.

**Pick one artist** not already claimed by `artists`, with at least one favorite and at least one unplayed album of `ALBUM_MIN_TRACKS`. Prefer the artist with the most favorites, then the largest unplayed remainder.

**Show** that artist's unplayed albums.

**Title is dynamic:** `Because you favorited {artist.name}`.

Drop if no such artist remains. This is `FavoriteBias: only` applied to a discography remainder, not a second *for-you*.

### 8. `neglected-genre` — {Genre} you own and ignore

*Hint:* A lot of the library, none of the listening.

**Pick one `genre_key`.** Among the `NEGLECTED_LIBRARY_N` genres by track count in `track_genres`, exclude any in the recent-seed's top `NEGLECTED_LISTEN_N` genres. Remaining, highest `(library_track_count / (1 + recent_listen_count))` wins.

**Show** unplayed (or, if not enough, underplayed) albums that carry that `genre_key`.

**Title is dynamic:** `{display genre} you own and ignore`. Display spelling is `track_genres.genre` for that key (first-seen-wins, same as W10-1).

Drop if every large genre is also a listened genre — that is a well-used library, and the shelf would be a lie.

### 9. `guest-appearances` — Guest appearances

*Hint:* Artists you play, on records filed under someone else.

**Filter.** Albums of at least `ALBUM_MIN_TRACKS` where the **album artist** is not in the taste seed and at least one track's **performer** is, and the album is unplayed or underplayed (at least one track `play_count = 0`).

This is `related.ts`'s compilations strand aimed at the library rather than at the currently playing track. Drop if the seed is empty.

**Subtitle:** `{seed artist} appears`.

---

## Explicitly not 1.0

| Idea | Why not |
|---|---|
| Just arrived / Recently added | No `tracks.indexed_at`. `mtime` is the wrong clock. Schema sketched below. |
| Heavy rotation / top N | Dashboard. Backward. |
| Ratings shelf | `tracks.rating` is unwritten. |
| Skip archaeology | Skip rate is only inferable from 500 trail rows vs `listens`. |
| Time-of-day / "Saturday morning" | Cute, and `started_at` could do it; not a 1.0 category. |
| MusicBrainz similar / "fans also like" | Network, M7, different product. |
| Mixed-grain shelves | Second card component. Revisit when artist portraits exist locally. |
| Live smart playlists | D8 deferred query language. Save-as-playlist is a snapshot. |
| Shuffle-this-shelf control | Day-hash is the 1.0 freshness knob. |
| Third pinned rail fixture | D18's actual trigger. Not this. |
| Wrapped | W10-14, unspecified, narrative. |

---

## Data contract

No new tables. No new columns in 1.0. The contract is IPC and types, starting in `src/shared` as every other surface does.

### `src/shared/discover.ts`

```ts
export type DiscoverRecipeId =
  | 'for-you'
  | 'unplayed'
  | 'revisit'
  | 'artists'
  | 'almost-finished'
  | 'forgotten-favorites'
  | 'because-favorited'
  | 'neglected-genre'
  | 'guest-appearances'

export type DiscoverGrain = 'album' | 'track'

export const SHELF_ITEM_CAP = 10
export const SHELF_MIN_ITEMS = 3

export interface DiscoverAlbumItem {
  grain: 'album'
  albumId: number
  title: string
  artist: string | null
  year: number | null
  trackCount: number
  artworkHash: string | null
  why: string
}

export interface DiscoverTrackItem {
  grain: 'track'
  trackId: number
  title: string
  artist: string | null
  albumTitle: string | null
  artworkHash: string | null
  why: string
}

export type DiscoverItem = DiscoverAlbumItem | DiscoverTrackItem

export interface DiscoverShelf {
  id: DiscoverRecipeId
  title: string
  hint: string
  grain: DiscoverGrain
  items: DiscoverItem[]  // length in [SHELF_MIN_ITEMS, SHELF_ITEM_CAP], except cold-start unplayed
}

export interface DiscoverShelvesResult {
  dayKey: string          // UTC YYYY-MM-DD, so the pane can say "today's shelves" if it wants
  shelves: DiscoverShelf[]
}
```

`RelatedAlbum` is the wrong type: it carries a filtered-predicate `total` in spirit even when it doesn't, and it has no `why` and no artwork. Discover items are their own shape.

### IPC

```
discover.shelves:  { request: void; response: DiscoverShelvesResult }
discover.saveShelf: { request: { recipeId: DiscoverRecipeId }; response: Playlist }
```

`saveShelf` re-runs that one recipe against the current exclusion set (or materializes from the last `shelves` result — pick one and test it; the last result is the one the operator is looking at, so **snapshot the last result**, do not re-query). Expand album items to tracks in disc/track/id order, the same order Library uses. Create via `playlists.create` with name `{shelf.title} · {dayKey}`, then `playlists.addTracks`. The new playlist becomes the viewed Curate stop.

`void` request on `shelves`: the clock is main's. Tests call the recipe function with `nowMs` directly and do not go through IPC for determinism.

Do not add `discover.playShelf`. Playing is a renderer gesture over item ids the pane already has, through the same activation path Library uses. Main does not need to know about the queue.

---

## Play actions

The pane, not main:

- **Album card, activate:** play the album in disc/track order. Reuse the existing library album activation. Do not invent a second play-order builder.
- **Track card, activate:** play that track. Same `trackActivation` path as a TrackList row.
- **Queue:** the same secondary gesture TrackList already has, per item. No "queue the whole shelf" in 1.0 unless it falls out of multi-select for free; do not build a parallel selector.
- **Save as playlist:** primary shelf-level action, labelled as such, because the pane copy already promised it.

---

## UI

`DiscoverPane.vue` drops the Placeholder badge when `shelves` is a real result — including a result with one shelf, including a cold-start `unplayed`. The badge is for "these cards are skeletons". Empty library (zero tracks) keeps a designed empty state, not skeletons: the existing header copy, and no fake vinyls.

Each shelf is still its own horizontal scroller. Ten cards do not get a windowing library. Token layer only. Panels remain islands: the pane does not import the Listening dashboard, the Tunedeck, or Library facets.

Dynamic titles replace the placeholder `h3` text. Hints stay the static recipe lines above.

Cold start (zero `listens` rows, some tracks): render `unplayed` only, plus any recipe that does not need a seed (`forgotten-favorites` if hearts exist). Do not render empty skeletons for `for-you` / `revisit` / `artists`.

Artwork: `oscine:` thumbnail URLs the way Library already addresses album art. No remote origin.

---

## Engine shape

```
src/shared/discover.ts          # types, caps, recipe ids
src/main/library/discover/      # one module per recipe plus compose.ts
  constants.ts
  seed.ts                       # taste seed + window widening
  hash.ts                       # day-key + tie-break
  compose.ts                    # exclusion order, omit-thin, memo key
  recipes/forYou.ts
  …
tests/main/library/discover/
```

Each recipe is `(db, nowMs, claimed, seed) → items`. `compose` builds the seed once, walks the exclusion order, drops thin shelves, memoizes. Recipes do not call `stats.query`. That engine is range → group → rank; these are set-difference and fractions.

`related.ts` is not imported. If a ranking idea is worth sharing later, it moves to a third module. Do not couple the Tunedeck's seed-track pane to the Discover page to save a `ORDER BY`.

---

## Testing

A generated library, not the operator's. Enough shape to make each recipe's pick *unique and obvious*:

- Artist A: 6 albums, heavy recent listens on albums 1–2, albums 3–6 unplayed → `artists` names A and shows 3–6.
- Artist B: 1 favorite track, 3 unplayed albums, not A → `because-favorited` names B.
- Album C: 10 tracks, 7 with `play_count > 0`, 3 at 0, recent last played → `almost-finished`, not `revisit`.
- Album D: 8 tracks, all `play_count` 1 or 2, last played 200 days ago → `revisit`, and not on `almost-finished`.
- Album E: 12 tracks, all `play_count = 0`, artist in the seed → `unplayed` (if not claimed earlier).
- Hearted track F, `play_count = 0` → `forgotten-favorites`.
- Genre G: 20% of tracks, 0 recent listens; genre H: 10% of tracks, most of recent listens → `neglected-genre` is G.
- Artist A appearing on a Various-style album credited to Z, unplayed → `guest-appearances`.
- Zero listens, 50 unplayed albums → only `unplayed` (and favorites recipes if hearts exist). `for-you` / `revisit` / `artists` absent, not empty-headed.
- Same fixture, same `nowMs` → byte-identical `DiscoverShelvesResult`. Same fixture, `nowMs` + 24h UTC → ties may permute, scores must not.
- An album claimed by `for-you` does not appear on `unplayed` or `revisit`.
- `saveShelf` against a cached result creates a playlist whose track ids are the album expansions of *that* result, not a re-query.
- Time budget on a ~100k-track synthetic library for `compose`, written down, same spirit as W10-10. If it misses frame budget, that is a card, not a silent `RANDOM() LIMIT 10`.

Do not hit IPC for recipe tests. Call `compose` with an injected clock.

---

## Card breakdown

Workstream **W12**, depends on W2, W5, W10. Discover is Curate's null stop, but W5 still owns queue semantics and M4's gate; the recipe engine is a new surface with its own tests and should not hide inside W5-8.

| Id | Card | Notes |
|---|---|---|
| W12-1 | `src/shared/discover.ts` + IPC channels | Types, caps, `discover.shelves` / `discover.saveShelf`. No implementation behind the handler yet. |
| W12-2 | Recipe engine: seed, hash, compose, the four placeholder recipes | `for-you`, `unplayed`, `revisit`, `artists`. Tests listed above for those four. Memo key. |
| W12-3 | Recipe engine: the five extras | `almost-finished`, `forgotten-favorites`, `because-favorited`, `neglected-genre`, `guest-appearances`. Same compose, same exclusion list. |
| W12-4 | `DiscoverPane` — real shelves, empty and cold-start states, drop the Placeholder badge | Artwork wall, token-only, dynamic titles. Showing the wall is the card; play/save is W12-5. |
| W12-5 | Play, queue, save-as-playlist | Activation reuse; `saveShelf` snapshots the last result; new playlist becomes the viewed stop. |

D20 landed in `fermata-design` with this specification; there is no separate wiki-copy card. W12-2 is the load-bearing card. W12-3 must not fork compose. W12-4 must not compute recipes in the renderer.

---

## Recorded debts

1. **No `tracks.indexed_at`.** "Just arrived" is the obvious tenth shelf and it would be a lie today. The column is `INTEGER NOT NULL`, stamped on `INSERT`, **never** updated on the `(root_id, rel_path)` upsert (a rescan is not an arrival). Existing rows backfill from `roots.added_at` or a one-time `now` — pick at migration time and say which. `mtime` stays the rescan key. This is also the column D18's "Recently Added" fixture would read, if that trigger is ever fired on purpose.
2. **No skip-rate.** A skip is a `play_history` row and no `listens` row, but the trail is 500 deep. Mining it for "started and abandoned as a habit" is a session statistic, not a library one.
3. **`/` still splits genres.** Inherited from W10-1. Neglected-genre inherits the misfires.
4. **No Various Artists identity.** Guest-appearances uses album-artist ∉ seed ∧ performer ∈ seed. A well-tagged VA album works; an album mistagged as the guest's own discography will be claimed by `artists` / `unplayed` instead. Do not string-match "Various".
5. **No artist portraits.** Dynamic titles carry the artist; cards stay album art. M7's images do not leak in here even after they exist, unless a later card opts in behind D14.
6. **No rollup indexes for these queries.** Same position as migration 014: add them when W12-3's 100k timing is measured slow, not before.
7. **Save-as-playlist is not a live smart playlist.** Re-saving tomorrow can duplicate a playlist of the same name with a new `dayKey`. That is correct for a snapshot. Dedup-by-name is not.
