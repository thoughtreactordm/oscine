import type {
  LibraryBrowseFilters,
  ListTracksQuery,
  ListTracksResult,
  SortDirection,
  Track,
  TrackSortColumn
} from '@shared/library'

/**
 * What "next track" means.
 *
 * This is the first appearance of play order, and it is deliberately an
 * interface rather than a peek at the track list's cache. W5 replaces the
 * implementation with playlists and the up-next queue (design §5) and nothing
 * above this line changes: `next` stays "whatever `at(index + 1)` returns", and
 * "there is no next" stays `null` rather than an error.
 *
 * ## Why a snapshot and not a live view of the list
 *
 * Design §5 keeps `viewedPlaylistId` and `playingPlaylistId` separate —
 * browsing must not disturb playback. M1 has no playlists, but it has the same
 * two roles: the sort the user is *looking at* and the sort they are *playing
 * through*. Starting a track captures the list's ordering into a `PlayOrder`;
 * re-sorting the list afterwards changes what is browsed and leaves playback
 * alone. Playing another row adopts the new ordering, which is rule 3 of §5
 * arriving early.
 *
 * The snapshot also removes a whole class of bug. A live view would have to
 * answer "where does the playing track sit now?" after every re-sort, and the
 * M1 contract has no "index of track N under this ordering" query — the answer
 * would have to be guessed from whichever pages happened to be cached.
 */
export interface PlayOrder {
  /**
   * Identity of the ordering, for tests and diagnostics. Two orders with the
   * same id traverse the same rows in the same sequence.
   */
  readonly id: string

  /**
   * The track at a position, or `null` when the position falls outside the
   * order. Asynchronous because the order is authoritative in main; the
   * renderer holds no complete copy of it and at 100k rows never will.
   */
  at(index: number): Promise<Track | null>
}

export interface ListPlayOrderDeps {
  fetchPage: (query: ListTracksQuery) => Promise<ListTracksResult>
  sort: TrackSortColumn
  direction: SortDirection
  filters?: LibraryBrowseFilters
}

/**
 * A play order over the whole library under one sort — M1's only kind.
 *
 * Resolves a position with a one-row query rather than consulting the track
 * list's page cache. That looks wasteful next to a cache that probably holds
 * the row already, but the cache is keyed to the ordering the user is *viewing*
 * and evicts under scrolling, so it can only answer opportunistically. A single
 * indexed `LIMIT 1 OFFSET n` always can.
 */
export function createListPlayOrder(deps: ListPlayOrderDeps): PlayOrder {
  const { fetchPage, sort, direction } = deps
  const filters = { ...deps.filters }
  const filterId =
    Object.keys(filters).length === 0
      ? ''
      : `:${[
          filters.rootId ?? '',
          filters.artistId ?? '',
          filters.albumId ?? '',
          filters.searchText ?? ''
        ].join(':')}`

  return {
    id: `list:${sort}:${direction}${filterId}`,

    async at(index: number): Promise<Track | null> {
      // A negative or fractional offset is a caller bug, and main would reject
      // it as `invalid-request`. Treated as "nothing there", which is what the
      // ends of the list mean anyway.
      if (!Number.isInteger(index) || index < 0) return null

      const result = await fetchPage({ ...filters, sort, direction, offset: index, limit: 1 })
      // Past the last row SQLite returns no rows rather than failing, which is
      // exactly the clean stop the transport wants.
      return result.tracks[0] ?? null
    }
  }
}
