import { MAX_TRACK_ID_PAGE, MAX_TRACK_PAGE, type Track } from './library'

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
