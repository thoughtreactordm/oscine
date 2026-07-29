import { computed, ref } from 'vue'
import {
  MAX_TRACK_PAGE,
  type ListTracksQuery,
  type ListTracksResult,
  type SortDirection,
  type Track,
  type TrackSortColumn
} from '@shared/library'

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
  pageSize?: number
  maxCachedPages?: number
}

/**
 * Where a navigation key moves the selection, or `null` when the key is not a
 * navigation key and the event should be left alone.
 *
 * Split out as a pure function because it is entirely arithmetic, and
 * arithmetic that is wrong at the ends of a 100k-row list is invisible until
 * someone presses End.
 */
export function nextSelectionIndex(
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
  const maxCachedPages = Math.max(1, deps.maxCachedPages ?? MAX_CACHED_PAGES)

  const sort = ref<TrackSortColumn>('artist')
  const direction = ref<SortDirection>('asc')
  const total = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)

  /**
   * Selection is two values on purpose.
   *
   * `selectedId` is what the user chose; `selectedIndex` is where it currently
   * sits. A re-sort invalidates the second and not the first, and the M1
   * contract has no "where is track N under this ordering" query — so the index
   * is dropped and re-adopted opportunistically when the row arrives in a
   * loaded page. See `syncSelection`.
   */
  const selectedIndex = ref<number | null>(null)
  const selectedId = ref<number | null>(null)

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

  const pages = new Map<number, Track[]>()
  const pending = new Set<number>()

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
   * Reconciles the two halves of the selection against a page that just landed.
   *
   * Runs in both directions: a re-sort leaves the id without an index, and
   * keyboard navigation onto an unloaded row leaves an index without an id.
   */
  function syncSelection(tracks: Track[], page: number): void {
    if (selectedIndex.value === null) {
      if (selectedId.value === null) return
      const offset = tracks.findIndex((track) => track.id === selectedId.value)
      if (offset >= 0) selectedIndex.value = page * pageSize + offset
      return
    }

    const offset = selectedIndex.value - page * pageSize
    if (offset >= 0 && offset < tracks.length) {
      selectedId.value = tracks[offset]?.id ?? null
    }
  }

  async function loadPage(page: number): Promise<void> {
    if (pages.has(page) || pending.has(page)) return

    const requested = ordering.value
    pending.add(page)
    loading.value = true

    try {
      const result = await deps.fetchPage({
        sort: sort.value,
        direction: direction.value,
        offset: page * pageSize,
        limit: pageSize
      })

      // A response issued before the ordering changed describes a different
      // list. Storing it would interleave two orderings in one column of rows.
      if (requested !== ordering.value) return

      total.value = result.total
      pages.set(page, result.tracks)
      syncSelection(result.tracks, page)
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

  function invalidate(): void {
    ordering.value++
    pages.clear()
    pending.clear()
    loading.value = false
    selectedIndex.value = null
    revision.value++
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

  /** Re-reads everything under the current ordering — after a scan changes the row count. */
  function reload(): void {
    invalidate()
  }

  function select(index: number): void {
    if (!Number.isInteger(index) || index < 0) return
    if (total.value > 0 && index >= total.value) return

    selectedIndex.value = index
    selectedId.value = rowAt(index)?.id ?? null
  }

  /** Applies a navigation key. Returns the new index, or `null` if the key was not ours. */
  function moveSelection(key: string, rowsPerPage: number): number | null {
    const next = nextSelectionIndex(key, selectedIndex.value, total.value, rowsPerPage)
    if (next === null) return null
    select(next)
    return next
  }

  const selectedTrack = computed(() =>
    selectedIndex.value === null ? undefined : rowAt(selectedIndex.value)
  )

  return {
    sort,
    direction,
    total,
    loading,
    error,
    ordering,
    selectedIndex,
    selectedId,
    selectedTrack,
    pageSize,
    rowAt,
    ensureRange,
    setSort,
    select,
    moveSelection,
    reload,
    /** Test seam: how much of the library the panel is actually holding. */
    cachedPageCount: (): number => pages.size
  }
}

export type TrackWindow = ReturnType<typeof createTrackWindow>
