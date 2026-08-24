import { MAX_TRACK_ID_PAGE, MAX_TRACK_PAGE, type Track } from './library'
import type { Playlist } from './playlists'

/**
 * Favorites — **D18**.
 *
 * A boolean fact about a track, stored in `track_favorites` and surfaced three
 * ways: one at a time when the operator clicks a heart, in batch when something
 * needs to know about a set of tracks it did not get through the track
 * projection, and as a paged list for the rail's pinned entry.
 *
 * Local and authoritative. Nothing here reads a remote loved-tracks list, and
 * nothing here waits on a network call — the whole surface works with no account
 * connected, which is what lets the heart respond at click speed and lets W11-6
 * be a separate card rather than a dependency.
 */

/**
 * The state of one track's heart, as the store found it.
 *
 * Returned by `toggle` rather than left for the caller to infer from "I asked
 * for the opposite of what I had", which is a guess that goes wrong the moment
 * two views of the same track disagree about what they had. `favoritedAt` comes
 * back with it because the rail orders by it, so a view that inserts a newly
 * hearted row does not have to re-read the list to know where it goes.
 */
export interface FavoriteState {
  readonly trackId: number
  readonly favorite: boolean
  /** UTC ms, or `null` when the track is not favorited. */
  readonly favoritedAt: number | null
}

export interface ToggleFavoriteRequest {
  readonly trackId: number
}

/**
 * A batch state lookup: which of these tracks are favorited.
 *
 * The answer is the favorited subset rather than a boolean per id, because the
 * caller already holds the ids it asked about and a sparse answer is smaller by
 * exactly the amount that matters — a page of 10k tracks with nine hearts among
 * them crosses the boundary as nine numbers.
 */
export interface FavoriteStateRequest {
  readonly trackIds: readonly number[]
}

export interface FavoriteStateResult {
  /** The ids from the request that are favorited. Order is not meaningful. */
  readonly favoritedIds: number[]
}

/**
 * The ceiling on one batch, shared with `listTrackIds` rather than chosen anew.
 *
 * The two answer the same question about the same window — one resolves it to
 * ids, the other asks a fact about ids — so a caller that legally holds a range
 * from the first can legally ask about all of it here. A second, smaller number
 * would make that a two-request operation for no reason a reader could find.
 */
export const MAX_FAVORITE_STATE_IDS = MAX_TRACK_ID_PAGE

/**
 * The rail's window. Paged like every other list, and ordered newest-hearted
 * first — see D18 for why there is no authored position to offer instead.
 */
export interface ListFavoritesQuery {
  readonly limit: number
  readonly offset: number
}

export interface ListFavoritesResult {
  readonly tracks: Track[]
  readonly total: number
}

/** Display rows, so the same ceiling as `listTracks`. */
export const MAX_FAVORITES_PAGE = MAX_TRACK_PAGE

/**
 * The same window, ids only — what a Shift-range in the rail's pane resolves
 * through.
 *
 * Separate from `ListFavoritesQuery` for the reason `listTrackIds` is separate
 * from `listTracks`: a range selection routinely spans rows the pane never
 * loaded, and it must be visibly unable to put display rows into the page cache
 * on its way past. Same order, an order of magnitude more of it per request,
 * because the response is integers rather than the wide projection.
 */
export type ListFavoriteIdsQuery = ListFavoritesQuery

export interface ListFavoriteIdsResult {
  readonly ids: number[]
  /** Total favorited tracks, ignoring offset and limit. Same value `list` reports. */
  readonly total: number
}

/** Ids, so the same ceiling as `listTrackIds`. */
export const MAX_FAVORITE_IDS_PAGE = MAX_TRACK_ID_PAGE

/**
 * The playing artist's favorites, for the deck's "Favorite Songs" pane.
 *
 * **Seeded by track, like every other thing the deck asks** — `RelatedQuery` is
 * the same shape for the same reason. The artist is resolved from
 * `tracks.artist_id` inside the query rather than supplied by the caller, and
 * that is the load-bearing decision here rather than a convenience.
 *
 * An `artistId` parameter would have meant the renderer getting one first, and
 * the only thing in the deck that holds one is `artist.resolve` — which is the
 * call that may open a socket. On a machine with lookups *declined* that returns
 * at once, but on one that is merely unplugged it returns when a connection
 * times out, and a pane of local rows would have sat behind it. This surface
 * touches two local tables and answers in a millisecond whatever the network is
 * doing, which is **D14**'s third rule kept by construction rather than by
 * remembering to. An artist Fermata cannot resolve still has favorites.
 */
export interface ArtistFavoritesQuery {
  readonly trackId: number
}

export interface ArtistFavoritesResult {
  /** Echoed back, so a reply that outran a track change can be discarded. */
  readonly seedTrackId: number
  /**
   * The `artists` row the seed's `artist_id` pointed at, or `null` when the
   * track carries no artist at all.
   *
   * Distinguishes "this artist has no favorites" from "there is no artist to
   * ask about", which are two different sentences in the pane and would be one
   * grey one if this were folded into an empty `tracks`.
   */
  readonly artistId: number | null
  /** `favorited_at` descending, capped at `ARTIST_FAVORITES_LIMIT`. */
  readonly tracks: Track[]
  /** More rows existed than the cap allowed. The pane says so rather than lying. */
  readonly truncated: boolean
}

/**
 * Rows the pane may show, and the reason it is one round trip rather than a
 * paged window.
 *
 * The same number `RELATED_SECTION_LIMIT` picked, and restated here rather than
 * imported because the two are not the same decision: that one bounds a genre
 * that can match a third of the library, and this one bounds a set that is
 * already small — favorites *by one artist* is a handful for almost everybody.
 * Fifty is well past what anyone reads in a deck column and small enough that
 * the whole answer is a few kilobytes of structured clone, which is what lets
 * this be a query per artist instead of a window with a scroll to chase.
 */
export const ARTIST_FAVORITES_LIMIT = 50

/**
 * Un-favorites a batch in one transaction.
 *
 * `toggle` is the gesture and this is not a bulk version of it: a toggle asks
 * for the opposite of whatever each row currently holds, which over a selection
 * would leave the set half hearted and half not depending on where it started.
 * This says *remove*, so a selection of four hundred rows in the rail's pane
 * comes out as four hundred rows removed and no argument about which way each
 * one was pointing.
 *
 * There is no batch *add*. Hearting is one click on one row, and a verb that
 * favorited a selection wholesale would be a gesture nothing in the UI makes.
 */
export interface RemoveFavoritesRequest {
  readonly trackIds: readonly number[]
}

export interface RemoveFavoritesResult {
  /** Rows actually deleted, which is at most `trackIds.length` and may be fewer. */
  readonly removed: number
}

/** The same ceiling as the batch state lookup, and for the same reason. */
export const MAX_FAVORITE_REMOVE_IDS = MAX_TRACK_ID_PAGE

/**
 * Favorites beyond tracks — **D24**.
 *
 * Playlists and artists become favoritable on their own per-entity tables
 * (`playlist_favorites`, `artist_favorites`), each mirroring `track_favorites`
 * exactly. The **star** glyph denotes them; the **heart** stays tracks-only.
 * This preserves D18's per-entity design rather than replacing it with a
 * polymorphic table.
 *
 * The shapes below mirror the track surface — toggle, batch state, list — for
 * two new subjects. What is deliberately *not* mirrored is the paging: the
 * playlist and artist lists are the Quick Menu's short, capped, recomputed-on-
 * open convenience views (D26), not windowed collections. There is no `offset`,
 * no `total`, and no id-only variant — a drawer of a dozen rows needs none of
 * the machinery a 100k-track rail does.
 */

/**
 * The favorited subset of a batch, shared by both new entity types.
 *
 * The answer is the ids that *are* favorited rather than a boolean per id, for
 * `FavoriteStateResult`'s reason: the caller already holds the ids it asked
 * about, and a sparse answer is smaller by exactly the amount that matters. A
 * toggle returns it too — the row that flipped is either in the set or not, and
 * the star reads its own state off that rather than predicting the outcome of
 * its own click.
 */
export interface EntityFavoriteStateResult {
  /** The ids from the request that are favorited. Order is not meaningful. */
  readonly favoritedIds: number[]
}

export interface TogglePlaylistFavoriteRequest {
  readonly playlistId: number
}

export interface PlaylistFavoriteStateRequest {
  readonly playlistIds: readonly number[]
}

export type PlaylistFavoriteStateResult = EntityFavoriteStateResult

/**
 * The Quick Menu's Favorite Playlists list — star-favorited playlists,
 * `favorited_at` descending, capped (D26). Short and computed, not paged.
 */
export interface ListFavoritePlaylistsQuery {
  readonly limit: number
}

export interface ListFavoritePlaylistsResult {
  readonly playlists: Playlist[]
}

export interface ToggleArtistFavoriteRequest {
  readonly artistId: number
}

export interface ArtistFavoriteStateRequest {
  readonly artistIds: readonly number[]
}

export type ArtistFavoriteStateResult = EntityFavoriteStateResult

/**
 * A favorited artist as the Quick Menu draws it — **the real thing**, not the
 * existing `artistFavorites.ts` store, which is "favorite tracks by this
 * artist" and favorites no artist at all.
 *
 * There is no `Artist` type in `src/shared` today and the drawer needs only
 * three fields: the id it navigates to, the name it shows, and an artwork hash
 * where D14's artist image has resolved one (`null` for the many artists it has
 * not). Kept minimal on purpose — a fuller artist projection is not this list's
 * to carry.
 */
export interface FavoriteArtist {
  readonly id: number
  readonly name: string
  readonly artworkHash: string | null
}

/**
 * The Quick Menu's Favorite Artists list — star-favorited artists,
 * `favorited_at` descending, capped (D26). Short and computed, not paged.
 */
export interface ListFavoriteArtistsQuery {
  readonly limit: number
}

export interface ListFavoriteArtistsResult {
  readonly artists: FavoriteArtist[]
}

/**
 * The default cap for both Quick Menu favorite lists.
 *
 * D26 keeps these lists short — a drawer, not a rail. Ten is well past what the
 * three-list drawer shows at rest and small enough that the whole answer is a
 * handful of rows of structured clone, which is what lets each list be one
 * unpaged query recomputed on open.
 */
export const QUICK_MENU_FAVORITES_LIMIT = 10
