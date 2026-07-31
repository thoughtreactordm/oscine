import {
  browseFilterKey,
  plainBrowseFilters,
  type LibraryBrowseFilters,
  type ListTracksQuery,
  type ListTracksResult,
  type SortDirection,
  type Track,
  type TrackSortColumn
} from '@shared/library'
import type { ListPlaylistEntriesQuery, ListPlaylistEntriesResult } from '@shared/playlists'

/**
 * What "next track" means.
 *
 * This is the first appearance of play order, and it is deliberately an
 * interface rather than a peek at the track list's cache. W5 adds a second
 * implementation over playlists and nothing above this line changes: `next`
 * stays "whatever `at(index + 1)` returns", and "there is no next" stays `null`
 * rather than an error. Shuffle and repeat compose with either without knowing
 * which they were handed, which is the whole of what the interface bought.
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

  /**
   * How many positions the order has, or `null` when that cannot be
   * established.
   *
   * Not needed to walk forwards — `at()` reporting `null` is what the end of
   * the order means — but wrapping cannot be expressed without it, and neither
   * can shuffling, which has to permute a range before it can name one. Both
   * arrived with repeat and shuffle rather than being reserved in advance.
   *
   * `null` rather than a rejection or a zero: a failed count degrades repeat
   * to a clean stop at the end, which is exactly the behaviour that was there
   * before, whereas a zero would read as an empty order and stop playback.
   *
   * A snapshot, like the ordering itself. A scan that adds rows under a
   * playing order changes neither this nor what `at()` resolves — the same
   * property the offsets have always had.
   */
  count(): Promise<number | null>
}

/**
 * Wraps a length query so one order asks main for its length at most once.
 *
 * Shared by both implementations because the retry rule is the subtle part, not
 * the caching: a failure clears the memo instead of remembering `null`, so a
 * count that lost once to a busy main process does not disable wrapping for the
 * rest of the session. Held as the promise rather than the value so two callers
 * arriving together share one round trip — the transport asks on every press
 * and the boundary path asks on every track under repeat.
 */
function memoizedCount(resolveTotal: () => Promise<number>): () => Promise<number | null> {
  let counted: Promise<number | null> | null = null

  return () => {
    counted ??= (async () => {
      try {
        return await resolveTotal()
      } catch {
        counted = null
        return null
      }
    })()
    return counted
  }
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
  // Plain, not merely copied: these arrive from the Pinia store, which hands
  // back a reactive proxy, and every one of them ends up in an IPC request.
  const filters = plainBrowseFilters(deps.filters ?? {})
  // Canonical, so a selection clicked bottom-to-top names the same order as the
  // same selection clicked top-to-bottom. An id that varied with click order
  // would read as a changed queue under a playing track.
  const filterId = Object.keys(filters).length === 0 ? '' : `:${browseFilterKey(filters)}`

  const count = memoizedCount(async () => {
    // `limit: 1` rather than zero: main rejects a non-positive limit, and the
    // row that comes back is the cheapest possible one to discard. `total` is
    // reported ignoring offset and limit, which is the number wanted here.
    const result = await fetchPage({ ...filters, sort, direction, offset: 0, limit: 1 })
    return result.total
  })

  return {
    id: `list:${sort}:${direction}${filterId}`,

    count,

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

export interface PlaylistPlayOrderDeps {
  playlistId: number
  fetchEntries: (query: ListPlaylistEntriesQuery) => Promise<ListPlaylistEntriesResult>
}

/**
 * A play order over one playlist's entries, in position order — M4's second
 * kind, and the one `PlayOrder` was written as an interface to admit.
 *
 * Structurally the same shape as the list order, and deliberately so: one
 * indexed row per position, a memoised length, `null` off the end. Everything
 * above it — shuffle, repeat, the scheduler's decode-ahead — is untouched by
 * which of the two it was handed, which is what "shuffle and repeat compose
 * with anything satisfying `PlayOrder`" has to mean in practice.
 *
 * ## What it deliberately does not carry
 *
 * `PlaylistEntry.id` is the identity of a row everywhere else in the playlist
 * contract, because D12 makes the same track legal twice, and only the entry id
 * can tell two such rows apart. It stops here. A `PlayOrder` names positions and
 * resolves them to tracks; the position *is* the identity of a row in a
 * traversal, and duplicates are not ambiguous under it — position 3 and
 * position 40 are different positions whatever they hold. Adding an entry id to
 * `at()` would put a playlist-shaped field on the interface the library order
 * cannot fill.
 *
 * ## Ordering, not contents
 *
 * The same snapshot property the list order has, and with the same limit: what
 * is captured is *how to traverse*, not *what was there*. Reordering a playlist
 * under a playing traversal changes what the next position resolves to, exactly
 * as a rescan does for the library. That is the intended behaviour — the
 * alternative is a queue that silently disagrees with the tab the user is
 * editing — and the up-next queue (§5) is where the transient, edit-proof
 * ordering lives.
 */
export function createPlaylistPlayOrder(deps: PlaylistPlayOrderDeps): PlayOrder {
  const { playlistId, fetchEntries } = deps

  const count = memoizedCount(async () => {
    // `limit: 1` for the same reason as the list order: main rejects a
    // non-positive limit and `total` ignores the window anyway.
    const result = await fetchEntries({ playlistId, offset: 0, limit: 1 })
    return result.total
  })

  return {
    // The playlist id alone. Two orders over the same playlist traverse the
    // same rows in the same sequence, and nothing else about a playlist —
    // its name, its crossfade, how many entries it had when this was built —
    // changes that sequence.
    id: `playlist:${playlistId}`,

    count,

    async at(index: number): Promise<Track | null> {
      if (!Number.isInteger(index) || index < 0) return null

      const result = await fetchEntries({ playlistId, offset: index, limit: 1 })
      return result.entries[0]?.track ?? null
    }
  }
}
