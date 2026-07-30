import { computed, ref } from 'vue'
import {
  MAX_TRACK_ID_PAGE,
  MAX_TRACK_PAGE,
  type LibraryBrowseFilters,
  type ListTrackGroupsQuery,
  type ListTrackGroupsResult,
  type ListTrackIdsQuery,
  type ListTrackIdsResult,
  type ListTracksQuery,
  type ListTracksResult,
  type OrderTrackIdsQuery,
  type SortDirection,
  type Track,
  type TrackGroup,
  type TrackSortColumn
} from '@shared/library'
// Relative rather than aliased: `tsconfig.node.json` reaches this module through
// the renderer tests, and that project does not map `@renderer`.
import {
  createTrackSelection,
  selectionIntent,
  type SelectionIntent,
  type SelectionModifiers
} from './trackSelection'

/**
 * The windowing engine behind the track list.
 *
 * The panel never holds the library. It holds a handful of pages around
 * wherever the user is looking, asks main for the ones it is missing, and
 * throws away the ones it has scrolled far past. Sorting is a property of the
 * *query*, not of anything cached here — a column click discards the cache and
 * re-asks, because SQLite ordering 100k rows is cheaper than IPC shipping them.
 *
 * Kept free of Vue components and of `window.fermata` so it can be driven
 * against a synthetic 100k-row source in a plain unit test, which is the only
 * honest way to check the scaling claims this panel makes.
 */

/**
 * Rows per request.
 *
 * Comfortably under `MAX_TRACK_PAGE` and several viewports tall, so ordinary
 * scrolling crosses a page boundary occasionally rather than continuously.
 */
export const TRACK_PAGE_SIZE = 200

/**
 * Pages kept in memory — roughly 6,400 rows.
 *
 * Without a ceiling, scrolling a 100k library end to end would quietly retain
 * every row it passed, which is the same memory shape virtualization exists to
 * avoid.
 */
export const MAX_CACHED_PAGES = 32

export interface TrackWindowDeps {
  fetchPage: (query: ListTracksQuery) => Promise<ListTracksResult>
  /**
   * The same window as `fetchPage`, ids only.
   *
   * A separate dependency rather than a flag on `fetchPage` because the two have
   * genuinely different costs and ceilings, and because a range selection must
   * be visibly unable to put rows into the page cache.
   */
  fetchIdPage: (query: ListTrackIdsQuery) => Promise<ListTrackIdsResult>
  /** Orders an arbitrary id set the way this list would. */
  orderIds: (query: OrderTrackIdsQuery) => Promise<number[]>
  /**
   * The album runs behind the current list, for a grouped rendering.
   *
   * Optional because a list without it is merely ungrouped rather than broken,
   * which is also what a failed request degrades to.
   */
  fetchGroups?: (query: ListTrackGroupsQuery) => Promise<ListTrackGroupsResult>
  pageSize?: number
  /** Rows per id request. Defaults to `MAX_TRACK_ID_PAGE`. */
  idPageSize?: number
  maxCachedPages?: number
}

/**
 * The ordering a browse scope reads best in.
 *
 * One album is a running order. One artist is a discography, which means album
 * by album with each in playing order — `album` carries the disc/track
 * tiebreakers that make that true. Everything else is a flat list where the
 * artist is the only grouping worth defaulting to.
 *
 * Keyed on the scope rather than on the transition into it. The previous form
 * tested three transitions and had no case for *entering* an artist, so the
 * column simply stayed where it was; within one artist, ordering by artist name
 * is degenerate and the `t.id` tiebreaker — scan order, i.e. the directory
 * listing — silently decided what followed what.
 */
export function defaultSortFor(scope: LibraryBrowseFilters): TrackSortColumn {
  if (scope.albumId !== undefined) return 'trackNo'
  if (scope.artistId !== undefined) return 'album'
  return 'artist'
}

/**
 * Where a navigation key moves the focus, or `null` when the key is not a
 * navigation key and the event should be left alone.
 *
 * Split out as a pure function because it is entirely arithmetic, and
 * arithmetic that is wrong at the ends of a 100k-row list is invisible until
 * someone presses End.
 *
 * Addresses tracks by offset, not display rows, which is why album headers cost
 * it nothing: a header is not a track, so arrow keys walk straight past one.
 */
export function nextFocusIndex(
  key: string,
  current: number | null,
  total: number,
  rowsPerPage: number
): number | null {
  if (total <= 0) return null

  const last = total - 1
  const clamp = (index: number): number => Math.min(last, Math.max(0, index))
  const stride = Math.max(1, rowsPerPage)

  switch (key) {
    // With nothing selected, every key lands on the first row rather than
    // guessing at an anchor the user never set.
    case 'ArrowDown':
      return current === null ? 0 : clamp(current + 1)
    case 'ArrowUp':
      return current === null ? 0 : clamp(current - 1)
    case 'PageDown':
      return current === null ? 0 : clamp(current + stride)
    case 'PageUp':
      return current === null ? 0 : clamp(current - stride)
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}

export function createTrackWindow(deps: TrackWindowDeps) {
  const pageSize = deps.pageSize ?? TRACK_PAGE_SIZE
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > MAX_TRACK_PAGE) {
    // Main rejects an oversized `limit` outright, so this would otherwise
    // surface as an `invalid-request` the moment the user scrolled.
    throw new RangeError(`pageSize must be an integer between 1 and ${MAX_TRACK_PAGE}.`)
  }
  const idPageSize = deps.idPageSize ?? MAX_TRACK_ID_PAGE
  if (!Number.isInteger(idPageSize) || idPageSize <= 0 || idPageSize > MAX_TRACK_ID_PAGE) {
    throw new RangeError(`idPageSize must be an integer between 1 and ${MAX_TRACK_ID_PAGE}.`)
  }
  const maxCachedPages = Math.max(1, deps.maxCachedPages ?? MAX_CACHED_PAGES)

  const sort = ref<TrackSortColumn>('artist')
  const direction = ref<SortDirection>('asc')
  const filters = ref<LibraryBrowseFilters>({})
  const total = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)

  /**
   * Bumped whenever the cache changes.
   *
   * `rowAt` reads a plain `Map`, which Vue cannot track. Making the cache
   * reactive instead would deep-proxy every `Track` in it for no benefit —
   * rows are immutable snapshots from main.
   */
  const revision = ref(0)

  /** Ordering identity. Anything derived from row *positions* is stale when it changes. */
  const ordering = ref(0)

  const groupRuns = ref<TrackGroup[]>([])
  const groupsOrdering = ref(-1)
  /**
   * Runs, but only while they still describe the list on screen.
   *
   * Held against the generation they were fetched for rather than cleared on
   * every invalidation: a header drawn against the previous ordering would put
   * every row beneath it under the wrong album, which is worse than no header.
   */
  const groups = computed<TrackGroup[]>(() =>
    groupsOrdering.value === ordering.value ? groupRuns.value : []
  )

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

  /**
   * Drops the cached pages furthest from the viewport.
   *
   * Distance rather than recency: the page just scrolled past is the least
   * recently used one and also the first one a reversal needs back.
   */
  function evictDistantPages(): void {
    if (pages.size <= maxCachedPages) return

    const firstPage = pageOf(range.first)
    const lastPage = pageOf(range.last)
    const distance = (page: number): number =>
      page < firstPage ? firstPage - page : page > lastPage ? page - lastPage : 0

    const furthestFirst = [...pages.keys()].sort((a, b) => distance(b) - distance(a))
    for (const page of furthestFirst) {
      if (pages.size <= maxCachedPages) break
      // Never evict what is on screen, however tight the budget.
      if (distance(page) === 0) break
      pages.delete(page)
    }
  }

  /**
   * Ids for an inclusive index range, chunked to the id page ceiling.
   *
   * Sequential rather than concurrent: the chunks are only useful in order, and
   * a re-sort part-way through makes every remaining one worthless, so the loop
   * checks the ordering between chunks and stops rather than finishing work it
   * is about to throw away.
   */
  async function fetchIdRange(first: number, last: number): Promise<number[]> {
    const generation = ordering.value
    const ids: number[] = []

    for (let offset = first; offset <= last; offset += idPageSize) {
      const limit = Math.min(idPageSize, last - offset + 1)
      const result = await deps.fetchIdPage({
        ...filters.value,
        sort: sort.value,
        direction: direction.value,
        offset,
        limit
      })
      if (generation !== ordering.value) return ids
      ids.push(...result.ids)
      // A short page means the list ran out before `last` did.
      if (result.ids.length < limit) break
    }

    return ids
  }

  const selection = createTrackSelection({
    idAt: (index) => rowAt(index)?.id,
    fetchIdRange,
    orderIds: (ids) =>
      deps.orderIds({ sort: sort.value, direction: direction.value, ids: [...ids] }),
    ordering: () => ordering.value,
    total: () => total.value
  })

  async function loadPage(page: number): Promise<void> {
    if (pending.has(page) || (presentingOrdering === ordering.value && pages.has(page))) return

    const requested = ordering.value
    pending.add(page)
    loading.value = true

    try {
      const result = await deps.fetchPage({
        ...filters.value,
        sort: sort.value,
        direction: direction.value,
        offset: page * pageSize,
        limit: pageSize
      })

      // A response issued before the ordering changed describes a different
      // list. Storing it would interleave two orderings in one column of rows.
      if (requested !== ordering.value) return

      // Keep the last complete view mounted while a new sort/filter query is
      // pending. The first successful page atomically replaces that view.
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
      error.value = cause instanceof Error ? cause.message : 'Could not read the library.'
    } finally {
      // Guarded: `invalidate` already cleared `pending`, and deleting here
      // would remove an entry a *newer* request had just added under the same
      // page number, letting it be requested twice.
      if (requested === ordering.value) {
        pending.delete(page)
        loading.value = pending.size > 0
      }
    }
  }

  /** Declares the rows currently on screen. Missing pages are fetched; extras are dropped. */
  function ensureRange(first: number, last: number): void {
    range = { first: Math.max(0, first), last: Math.max(0, last) }

    const lastPage = pageOf(range.last)
    for (let page = pageOf(range.first); page <= lastPage; page++) {
      // Once the total is known, do not ask for pages past the end.
      if (total.value > 0 && page * pageSize >= total.value) break
      void loadPage(page)
    }
  }

  /**
   * The album runs for the current ordering.
   *
   * Album-major orderings only — under any other column the albums interleave
   * and there is nothing to head. A failure clears the runs rather than raising:
   * a list without headers is still the right list, whereas `error` would blank
   * rows that loaded perfectly well.
   */
  async function loadGroups(): Promise<void> {
    const requested = ordering.value
    if (!deps.fetchGroups || sort.value !== 'album') return

    try {
      const result = await deps.fetchGroups({
        ...filters.value,
        sort: sort.value,
        direction: direction.value
      })
      if (requested !== ordering.value) return
      groupRuns.value = result.groups
      groupsOrdering.value = requested
    } catch {
      if (requested !== ordering.value) return
      groupRuns.value = []
      groupsOrdering.value = requested
    }
  }

  function invalidate(): void {
    ordering.value++
    pending.clear()
    loading.value = true
    void loadGroups()
    // Positions only. Which tracks are selected survives a re-sort and a
    // filter — that is the contract W4-4 exists to keep.
    selection.invalidateIndices()
    ensureRange(range.first, range.last)
  }

  /** Click-to-sort: the same column flips direction, a new column starts ascending. */
  function setSort(column: TrackSortColumn): void {
    if (sort.value === column) {
      direction.value = direction.value === 'asc' ? 'desc' : 'asc'
    } else {
      sort.value = column
      direction.value = 'asc'
    }
    invalidate()
  }

  /**
   * Replaces the complete browse/search predicate.
   *
   * One generation bump invalidates every response issued for the old
   * predicate, which is important while an instant-search input is changing on
   * every keystroke.
   */
  function setFilters(next: LibraryBrowseFilters): void {
    // Search text is not scope. Typing must not throw away a column the user
    // chose, so only an artist/album change re-defaults the ordering.
    const scopeChanged =
      next.artistId !== filters.value.artistId || next.albumId !== filters.value.albumId
    if (scopeChanged) {
      sort.value = defaultSortFor(next)
      direction.value = 'asc'
    }
    filters.value = { ...next }
    invalidate()
  }

  /** Re-reads everything under the current ordering — after a scan changes the row count. */
  function reload(): void {
    invalidate()
  }

  /**
   * Applies a navigation key. Returns the new focus index, or `null` if the key
   * was not ours.
   *
   * Ctrl+arrow moves the focus and nothing else. That is the half of the
   * contract that makes a disjoint selection buildable from the keyboard at all:
   * walk to a row without disturbing the set, then commit it with Ctrl+Space.
   */
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

  /** Commits the focused row — Space and Ctrl+Space. */
  function commitFocus(modifiers: SelectionModifiers): void {
    const index = selection.focusIndex.value
    if (index === null) return
    const intent = selectionIntent(modifiers)
    void selection.apply(index, intent === 'toggle' ? 'toggle' : 'replace')
  }

  const focusedTrack = computed(() =>
    selection.focusIndex.value === null ? undefined : rowAt(selection.focusIndex.value)
  )

  return {
    sort,
    direction,
    filters,
    total,
    groups,
    /**
     * Re-asks for the album runs without disturbing the rows.
     *
     * Turning grouping on is not a change of ordering, so it must not go through
     * `invalidate`: that would discard every cached page and drop the selection's
     * positions to redraw a list whose rows have not moved.
     */
    refreshGroups: (): void => void loadGroups(),
    loading,
    error,
    ordering,
    pageSize,
    rowAt,
    ensureRange,
    setSort,
    setFilters,
    reload,

    /**
     * Selection surface. Flat rather than nested because Pinia only unwraps refs
     * at the top level of a setup store, and a template reaching
     * `panel.selection.count` would render the ref itself.
     */
    selectedIds: selection.ids,
    selectionCount: selection.count,
    selectionResolving: selection.resolving,
    focusIndex: selection.focusIndex,
    focusId: selection.focusId,
    anchorIndex: selection.anchorIndex,
    focusedTrack,
    isSelectedAt: selection.isSelectedAt,
    isSelected: selection.isSelected,
    selectAt: (index: number, intent: SelectionIntent): Promise<void> =>
      selection.apply(index, intent),
    moveFocus,
    commitFocus,
    clearSelection: selection.clear,
    /**
     * The selected tracks in list order, for M4's add-to-playlist action.
     *
     * Deliberately the only way to read the selection as an ordered list: it
     * resolves through main, so it is correct after a re-sort and never depends
     * on which rows happen to be rendered.
     */
    resolveSelection: selection.resolveSelection,

    /** Test seam: how much of the library the panel is actually holding. */
    cachedPageCount: (): number => pages.size
  }
}

export type TrackWindow = ReturnType<typeof createTrackWindow>
