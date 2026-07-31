import {
  plainBrowseFilters,
  MAX_TRACK_ID_PAGE,
  MAX_TRACK_PAGE,
  type GetTracksByIdsQuery,
  type LibraryBrowseFilters,
  type ListTrackIdsQuery,
  type ListTrackIdsResult,
  type SortDirection,
  type Track,
  type TrackSortColumn
} from '@shared/library'
import {
  MAX_PLAYLIST_ENTRY_PAGE,
  type ListPlaylistEntriesQuery,
  type ListPlaylistEntriesResult
} from '@shared/playlists'
import type { SessionRow } from './upNextQueue'

/**
 * Materializing a play order's next few thousand rows, in bulk.
 *
 * The scope a play session starts in has *always* bounded traversal —
 * `createListPlayOrder` folds the browse filters into every `at()` and into
 * `count()` — but a `PlayOrder` resolves one position per round trip, which is
 * right for a boundary and useless for filling a visible queue. This module is
 * the bulk counterpart: the same rows, read a few thousand at a time, so the
 * session tier can hold them (§5 amendment, 2026-07-31).
 *
 * ## No new IPC surface
 *
 * Deliberate, and the shuffle case is what would otherwise have forced one.
 * Both scopes are served by verbs that already exist — `library.listTrackIds`
 * plus `library.getTracksByIds` for the library, paged `playlists.listEntries`
 * for a playlist, whose entries carry their `track` already and need no widen.
 * Permuting an id array the renderer is holding costs nothing, so a
 * shuffle-aware query would have bought nothing either.
 *
 * Headless, like everything else under `playback/`: no Pinia, no engine, and
 * the two readers are ordinary functions over injected fetches.
 */

/**
 * Resolves *base* order positions to rows, in bulk.
 *
 * Keyed by position rather than returned as an array because a shuffled order
 * asks for scattered positions and a linear one for a contiguous run, and the
 * caller has to put either back against the order positions it started from.
 * Positions with no row — past the end, or a track deleted since — are simply
 * absent, exactly as `PlayOrder.at()` reports `null` for them.
 */
export type SessionRowReader = (
  baseIndices: readonly number[]
) => Promise<ReadonlyMap<number, Track>>

/** The span a set of positions covers, or `null` when there are none. */
function span(indices: readonly number[]): { first: number; last: number } | null {
  if (indices.length === 0) return null
  let first = indices[0]!
  let last = first
  for (const index of indices) {
    if (index < first) first = index
    if (index > last) last = index
  }
  return { first, last }
}

export interface LibraryScopeDeps {
  fetchTrackIds: (query: ListTrackIdsQuery) => Promise<ListTrackIdsResult>
  fetchTracksByIds: (query: GetTracksByIdsQuery) => Promise<readonly Track[]>
  sort: TrackSortColumn
  direction: SortDirection
  filters?: LibraryBrowseFilters
}

/**
 * The library scope: ids first, then a widen.
 *
 * Two verbs rather than paging `listTracks` directly, because the id page is an
 * order of magnitude larger than the row page — 10,000 flat integers against
 * 1,000 wide display rows with their three dimension joins. A linear session
 * therefore costs one id call and a handful of widens, where row paging would
 * have cost ten times as many round trips for the same rows.
 */
export function libraryScopeReader(deps: LibraryScopeDeps): SessionRowReader {
  const { fetchTrackIds, fetchTracksByIds, sort, direction } = deps
  // Plain, not merely copied: these arrive from the Pinia store as a reactive
  // proxy and every one of them ends up in an IPC request. Same reason
  // `createListPlayOrder` does it.
  const filters = plainBrowseFilters(deps.filters ?? {})

  return async (baseIndices) => {
    const rows = new Map<number, Track>()
    const window = span(baseIndices)
    if (window === null) return rows

    // Position -> id, over the span the wanted positions actually cover. Under
    // a linear order that span *is* the wanted run; under a shuffle it is most
    // of the scope, which is why it is read in id pages rather than row pages.
    const wanted = new Set(baseIndices)
    const idAt = new Map<number, number>()
    for (let offset = window.first; offset <= window.last; offset += MAX_TRACK_ID_PAGE) {
      const limit = Math.min(MAX_TRACK_ID_PAGE, window.last - offset + 1)
      const page = await fetchTrackIds({ ...filters, sort, direction, offset, limit })
      page.ids.forEach((id, position) => {
        const index = offset + position
        if (wanted.has(index)) idAt.set(index, id)
      })
      // Short page: the order ended inside this window, and asking for the rest
      // would be asking past the end of the scope.
      if (page.ids.length < limit) break
    }

    // Widened in row pages, and only for positions that resolved to an id.
    const ids = [...new Set(idAt.values())]
    const trackById = new Map<number, Track>()
    for (let offset = 0; offset < ids.length; offset += MAX_TRACK_PAGE) {
      const widened = await fetchTracksByIds({ ids: ids.slice(offset, offset + MAX_TRACK_PAGE) })
      for (const track of widened) trackById.set(track.id, track)
    }

    for (const [index, id] of idAt) {
      const track = trackById.get(id)
      // Absent means the row went away between the two calls, which is the same
      // "dropped rather than reported" bargain `getTracksByIds` already strikes.
      if (track) rows.set(index, track)
    }
    return rows
  }
}

export interface PlaylistScopeDeps {
  playlistId: number
  fetchEntries: (query: ListPlaylistEntriesQuery) => Promise<ListPlaylistEntriesResult>
}

/**
 * The playlist scope: one paged read and no widen.
 *
 * `PlaylistEntry` carries its `track` already, so the id-then-widen dance the
 * library needs has nothing to buy here. D12's duplicates are not a problem
 * either: positions are the key, and two entries holding the same track are two
 * positions.
 */
export function playlistScopeReader(deps: PlaylistScopeDeps): SessionRowReader {
  const { playlistId, fetchEntries } = deps

  return async (baseIndices) => {
    const rows = new Map<number, Track>()
    const window = span(baseIndices)
    if (window === null) return rows

    const wanted = new Set(baseIndices)
    for (let offset = window.first; offset <= window.last; offset += MAX_PLAYLIST_ENTRY_PAGE) {
      const limit = Math.min(MAX_PLAYLIST_ENTRY_PAGE, window.last - offset + 1)
      const page = await fetchEntries({ playlistId, offset, limit })
      page.entries.forEach((entry, position) => {
        const index = offset + position
        if (wanted.has(index)) rows.set(index, entry.track)
      })
      if (page.entries.length < limit) break
    }
    return rows
  }
}

export interface MaterializeSessionInput {
  read: SessionRowReader
  /**
   * Maps an order position to the base position it names. Identity for a linear
   * order; the permutation for a shuffled one, which is what makes the session
   * tier show the rows that will actually play (§5 rule 6 as amended).
   */
  baseIndexAt: (index: number) => Promise<number | null>
  /** The first order position to materialize — the row after the anchor. */
  from: number
  /** How many order positions at most. See `SESSION_QUEUE_CAP`. */
  limit: number
}

/**
 * The scope, as rows the queue can hold.
 *
 * Every row carries the **order position** it came from rather than its offset
 * within the fill, because that is what a drained session tier resumes after —
 * including a session truncated by the cap, which is the case the anchor rule
 * exists for and the only one where the two numbers differ enough to notice.
 */
export async function materializeSession(input: MaterializeSessionInput): Promise<SessionRow[]> {
  const { read, baseIndexAt, from, limit } = input
  if (limit <= 0) return []

  // Order position -> base position, resolved together rather than one await
  // at a time: a shuffled order memoizes its permutation, so every one of these
  // settles on the same round trip, and a linear order resolves them all
  // without a round trip at all. Sequentially this would be `limit` microtask
  // ticks before the first byte was fetched.
  const positions = Array.from({ length: limit }, (_, offset) => from + offset)
  const resolved = await Promise.all(positions.map((position) => baseIndexAt(position)))

  // Truncated at the first position the order does not have. Nothing beyond
  // the end of an order resolves, so this is where the scope stops.
  const end = resolved.indexOf(null)
  const kept = end === -1 ? resolved.length : end
  const orderPositions = positions.slice(0, kept)
  const baseIndices = resolved.slice(0, kept) as number[]

  const rows = await read(baseIndices)

  const materialized: SessionRow[] = []
  orderPositions.forEach((orderIndex, offset) => {
    const track = rows.get(baseIndices[offset]!)
    // A position that did not resolve is dropped rather than held as a gap: the
    // rows that did resolve each carry their own order position, so the
    // traversal behind them is unaffected by the hole.
    if (track) materialized.push({ track, orderIndex })
  })
  return materialized
}
