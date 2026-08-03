import { computed, ref } from 'vue'
import {
  MAX_FAVORITE_IDS_PAGE,
  MAX_FAVORITES_PAGE,
  type ListFavoriteIdsQuery,
  type ListFavoriteIdsResult,
  type ListFavoritesQuery,
  type ListFavoritesResult
} from '@shared/favorites'
import type { Track, TrackGroup } from '@shared/library'
import {
  createIndexedSelection,
  nextFocusIndex,
  selectionIntent,
  type SelectionIntent,
  type SelectionModifiers
} from './indexedSelection'

/**
 * The windowed view of `track_favorites` — the third `TrackListSource` — **D18**.
 *
 * `trackWindow` and `playlistEntryWindow`'s sibling, and it exists because of the
 * one thing neither of them can be talked into:
 *
 * - **Identity is `track_id`.** The playlist window keys everything by
 *   `playlist_entries.id`, because D12 makes the same track legal twice; a
 *   favorite is one row or none, so duplicates are not merely unusual here but
 *   impossible. That makes this the *simpler* of the two, not a variant of it —
 *   every set it holds is a set of track ids, which is what the queue, the
 *   playlists and `favorites.remove` all already speak. There is no crossing
 *   back, and so no `resolveSelectedTracks`.
 * - **There is no order to choose.** `ListFavoritesQuery` has no sort parameter
 *   and no position column behind it: D18's accepted cost is that this
 *   collection has no authored sequence, so `favorited_at` descending is the
 *   whole of it. `ordering` still exists and still counts *edits* — hearting a
 *   track inserts it at the top and moves every row below it, which is the same
 *   event to anything holding an index as a re-sort is in the library.
 *
 * No album runs either, and that is a scoping decision rather than a limit of the
 * shape: an album-major view of the favorites would need `favorites.list` to
 * grow an order parameter and a runs query beside it, which is more contract
 * than the pinned entry has yet been asked for. The source reports `groups` as
 * empty, which is a rendering `TrackList` already handles.
 *
 * Headless, like its two siblings: no Pinia, no IPC, no DOM. The store bolts the
 * real `favorites.list` on.
 */

/** Mirrors `TRACK_PAGE_SIZE`. Rows are the same size and travel the same wire. */
export const FAVORITES_PAGE_SIZE = 200

/** Mirrors `MAX_CACHED_PAGES` — roughly 6,400 rows held at once. */
export const MAX_CACHED_FAVORITE_PAGES = 32

export interface FavoritesWindowDeps {
  fetchPage: (query: ListFavoritesQuery) => Promise<ListFavoritesResult>
  /**
   * The same window, ids only. Separate from `fetchPage` for the reason both
   * siblings' is: a Shift-range routinely spans rows the pane never loaded, and
   * resolving it must be visibly unable to put rows into the page cache.
   */
  fetchIdPage: (query: ListFavoriteIdsQuery) => Promise<ListFavoriteIdsResult>
  pageSize?: number
  idPageSize?: number
  maxCachedPages?: number
}

export function createFavoritesWindow(deps: FavoritesWindowDeps) {
  const pageSize = deps.pageSize ?? FAVORITES_PAGE_SIZE
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > MAX_FAVORITES_PAGE) {
    throw new RangeError(`pageSize must be an integer between 1 and ${MAX_FAVORITES_PAGE}.`)
  }
  const idPageSize = deps.idPageSize ?? MAX_FAVORITE_IDS_PAGE
  if (!Number.isInteger(idPageSize) || idPageSize <= 0 || idPageSize > MAX_FAVORITE_IDS_PAGE) {
    throw new RangeError(`idPageSize must be an integer between 1 and ${MAX_FAVORITE_IDS_PAGE}.`)
  }
  const maxCachedPages = Math.max(1, deps.maxCachedPages ?? MAX_CACHED_FAVORITE_PAGES)

  const total = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)

  /** Bumped whenever the page cache changes; `pages` is a plain Map Vue cannot see. */
  const revision = ref(0)

  /**
   * Edit generation. Anything derived from row *positions* is stale when it
   * changes — a response in flight, a half-resolved Shift-range, the focus and
   * anchor indices. A heart clicked anywhere in the app is such an edit.
   */
  const ordering = ref(0)

  const pages = new Map<number, Track[]>()
  const pending = new Set<number>()
  let presentingOrdering = ordering.value

  let range = { first: 0, last: 0 }

  function pageOf(index: number): number {
    return Math.floor(index / pageSize)
  }

  function rowAt(index: number): Track | undefined {
    void revision.value
    return pages.get(pageOf(index))?.[index % pageSize]
  }

  function evictDistantPages(): void {
    if (pages.size <= maxCachedPages) return

    const firstPage = pageOf(range.first)
    const lastPage = pageOf(range.last)
    const distance = (page: number): number =>
      page < firstPage ? firstPage - page : page > lastPage ? page - lastPage : 0

    const furthestFirst = [...pages.keys()].sort((a, b) => distance(b) - distance(a))
    for (const page of furthestFirst) {
      if (pages.size <= maxCachedPages) break
      if (distance(page) === 0) break
      pages.delete(page)
    }
  }

  /** Track ids for an inclusive index range, chunked to the id page ceiling. */
  async function fetchIdRange(first: number, last: number): Promise<number[]> {
    if (last < first) return []

    const generation = ordering.value
    const ids: number[] = []

    for (let offset = first; offset <= last; offset += idPageSize) {
      const limit = Math.min(idPageSize, last - offset + 1)
      const result = await deps.fetchIdPage({ offset, limit })
      if (generation !== ordering.value) return ids
      ids.push(...result.ids)
      // A short page means the collection ran out before `last` did.
      if (result.ids.length < limit) break
    }

    return ids
  }

  /**
   * An arbitrary track-id set, put back into `favorited_at` order.
   *
   * Walked out of `fetchIdPage` for `playlistEntryWindow.orderIds`' reason:
   * the collection has exactly one order, so the answer is a filter of the id
   * list the pane can already ask for, and a channel to re-derive it in SQL
   * would be a second source of truth for the same sequence. Only ever run when
   * the operator acts on a selection, never while scrolling.
   */
  async function orderIds(wanted: readonly number[]): Promise<number[]> {
    if (wanted.length === 0) return []

    const generation = ordering.value
    const remaining = new Set(wanted)
    const ordered: number[] = []

    for (let offset = 0; remaining.size > 0; offset += idPageSize) {
      const result = await deps.fetchIdPage({ offset, limit: idPageSize })
      if (generation !== ordering.value) return ordered
      for (const trackId of result.ids) {
        if (remaining.delete(trackId)) ordered.push(trackId)
      }
      if (result.ids.length < idPageSize) break
    }

    return ordered
  }

  /**
   * The rows of a contiguous span.
   *
   * A span needs no searching: `fetchPage` takes an offset and a limit, so this
   * is the range read straight out, chunked only because the page ceiling says
   * so. What "play from row N" resolves the collection through.
   */
  async function tracksInRange(first: number, last: number): Promise<Track[]> {
    if (last < first) return []

    const generation = ordering.value
    const tracks: Track[] = []

    for (let offset = first; offset <= last; offset += pageSize) {
      const limit = Math.min(pageSize, last - offset + 1)
      const result = await deps.fetchPage({ offset, limit })
      if (generation !== ordering.value) return tracks
      tracks.push(...result.tracks)
      if (result.tracks.length < limit) break
    }

    return tracks
  }

  const selection = createIndexedSelection({
    // The track id, and there is nothing else it could be. See the note above.
    idAt: (index) => rowAt(index)?.id,
    fetchIdRange,
    orderIds,
    ordering: () => ordering.value,
    total: () => total.value
  })

  async function loadPage(page: number): Promise<void> {
    if (pending.has(page) || (presentingOrdering === ordering.value && pages.has(page))) return

    const requested = ordering.value
    pending.add(page)
    loading.value = true

    try {
      const result = await deps.fetchPage({ offset: page * pageSize, limit: pageSize })

      // A response issued before the last heart describes rows that have since
      // moved. Storing it would interleave two orderings in one column.
      if (requested !== ordering.value) return

      if (presentingOrdering !== requested) {
        pages.clear()
        presentingOrdering = requested
      }
      total.value = result.total
      pages.set(page, result.tracks)
      selection.adoptPage(result.tracks, page, pageSize)
      evictDistantPages()
      error.value = null
      revision.value++
    } catch (cause) {
      if (requested !== ordering.value) return
      error.value = cause instanceof Error ? cause.message : 'Could not read your favorites.'
    } finally {
      if (requested === ordering.value) {
        pending.delete(page)
        loading.value = pending.size > 0
      }
    }
  }

  function ensureRange(first: number, last: number): void {
    range = { first: Math.max(0, first), last: Math.max(0, last) }

    const lastPage = pageOf(range.last)
    for (let page = pageOf(range.first); page <= lastPage; page++) {
      if (total.value > 0 && page * pageSize >= total.value) break
      void loadPage(page)
    }
  }

  /**
   * Re-reads under a new edit generation.
   *
   * The one verb the store needs, and it is called for every heart clicked
   * anywhere in the app — a favorite lands at the top of this list and moves
   * every row below it. Membership survives; only positions are thrown away.
   */
  function reload(): void {
    ordering.value++
    pending.clear()
    loading.value = true
    selection.invalidateIndices()
    ensureRange(range.first, range.last)
  }

  /**
   * Drops track ids the collection no longer holds out of the selection.
   *
   * Called by whoever un-favorited them, for the reason `playlistEntryWindow`'s
   * is: `total` shrinking says nothing about *which* rows went, so a removal is
   * an event this window is told about rather than one it could observe.
   */
  function forget(removed: Iterable<number>): void {
    const gone = removed instanceof Set ? removed : new Set(removed)
    if (gone.size === 0) return
    selection.retain([...selection.ids.value].filter((id) => !gone.has(id)))
  }

  function moveFocus(
    key: string,
    rowsPerPage: number,
    modifiers: SelectionModifiers = {}
  ): number | null {
    const next = nextFocusIndex(key, selection.focusIndex.value, total.value, rowsPerPage)
    if (next === null) return null

    const intent = selectionIntent(modifiers)
    if (intent === 'toggle') selection.moveFocusOnly(next)
    else void selection.apply(next, intent)
    return next
  }

  function commitFocus(modifiers: SelectionModifiers): void {
    const index = selection.focusIndex.value
    if (index === null) return
    void selection.apply(index, selectionIntent(modifiers))
  }

  return {
    /** `tracks.id`. A favorite is one row or none, so there is nothing else it could be. */
    rowIdentity: 'track' as const,
    total,
    loading,
    error,
    ordering,

    /**
     * `TrackListSource` calls for these two and this collection has neither.
     *
     * `null` is what tells the list its headers are inert. There is no column
     * that could order `track_favorites` — that is D18's accepted cost stated
     * where a reader meets it, and it is the same `null` a playlist reports for
     * the same structural reason: the order is not a column's to change.
     */
    sort: null,
    direction: 'asc' as const,
    /** Always empty. See the note at the top of this module. */
    groups: computed<readonly TrackGroup[]>(() => []),
    scrollKey: computed(() => 'favorites'),

    pageSize,
    rowAt,
    ensureRange,
    reload,
    forget,
    tracksInRange,

    selectedIds: selection.ids,
    selectionCount: selection.count,
    selectionResolving: selection.resolving,
    focusIndex: selection.focusIndex,
    anchorIndex: selection.anchorIndex,
    focusedTrack: computed(() => {
      const index = selection.focusIndex.value
      return index === null ? null : (rowAt(index) ?? null)
    }),
    isSelectedAt: selection.isSelectedAt,
    isSelected: selection.isSelected,
    selectAt: (index: number, intent: SelectionIntent): Promise<void> =>
      selection.apply(index, intent),
    moveFocus,
    commitFocus,
    clearSelection: selection.clear,
    /** The selected rows as **track** ids, newest-hearted first. */
    resolveSelection: selection.resolveSelection,
    idsInRange: fetchIdRange,

    /** Test seam: how much of the collection the pane is actually holding. */
    cachedPageCount: (): number => pages.size
  }
}

export type FavoritesWindow = ReturnType<typeof createFavoritesWindow>
