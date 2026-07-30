import { computed, ref, shallowRef } from 'vue'
import {
  MAX_FACET_ID_PAGE,
  MAX_FACET_PAGE,
  plainBrowseFilters,
  type LibraryBrowseFilters,
  type ListFacetIdsQuery,
  type ListFacetIdsResult,
  type ListFacetsQuery
} from '@shared/library'
import {
  createIndexedSelection,
  nextFocusIndex,
  selectionIntent,
  type SelectionIntent,
  type SelectionModifiers
} from './indexedSelection'

export const FACET_PAGE_SIZE = 100
export const MAX_CACHED_FACET_PAGES = 12

export interface FacetPage<T> {
  items: T[]
  total: number
}

/** Which browse dimension this window selects into. */
export type FacetDimension = 'artistIds' | 'albumIds'

export interface FacetWindowDeps<T> {
  fetchPage: (query: ListFacetsQuery) => Promise<FacetPage<T>>
  /**
   * The same window, ids only.
   *
   * A separate dependency rather than a flag, for the same reason the track list
   * has one: a Shift-range must be visibly unable to put display rows into the
   * page cache. It doubles as the pruning query — see `pruneSelection`.
   */
  fetchIdPage: (query: ListFacetIdsQuery) => Promise<ListFacetIdsResult>
  /**
   * The filter field this window's selection becomes. Needed because pruning
   * asks main to filter the selection by itself, which means naming it.
   */
  dimension: FacetDimension
  pageSize?: number
  idPageSize?: number
  maxCachedPages?: number
}

/**
 * Bounded, generation-safe window for an artist or album facet, with its
 * selection.
 *
 * It retains the last good rows until the first page for a changed predicate
 * arrives. That makes an instant search feel continuous without permitting a
 * late response from the previous predicate into the new result.
 *
 * The selection lives here rather than in the pane component for the same reason
 * the track list's does: it is defined over index positions in a list only this
 * module knows the shape of, and a component that owned it would have to be
 * told about paging, generations and eviction to keep it honest.
 */
export function createFacetWindow<T extends { id: number }>(deps: FacetWindowDeps<T>) {
  const pageSize = deps.pageSize ?? FACET_PAGE_SIZE
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > MAX_FACET_PAGE) {
    throw new RangeError(`pageSize must be an integer between 1 and ${MAX_FACET_PAGE}.`)
  }
  const idPageSize = deps.idPageSize ?? MAX_FACET_ID_PAGE
  if (!Number.isInteger(idPageSize) || idPageSize <= 0 || idPageSize > MAX_FACET_ID_PAGE) {
    throw new RangeError(`idPageSize must be an integer between 1 and ${MAX_FACET_ID_PAGE}.`)
  }
  const maxCachedPages = Math.max(1, deps.maxCachedPages ?? MAX_CACHED_FACET_PAGES)

  /**
   * The browse predicate, held shallowly and stored plain.
   *
   * `shallowRef` rather than `ref` because a deep ref would re-proxy the id
   * arrays on every read, defeating the normalisation below — and every read of
   * this value ends up as an IPC request, which clones. The object is replaced
   * wholesale rather than mutated, so shallow reactivity is all it ever needed.
   */
  const filters = shallowRef<LibraryBrowseFilters>({})
  const total = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const revision = ref(0)
  const generation = ref(0)

  const pages = new Map<number, T[]>()
  const pending = new Set<number>()
  let presentingGeneration = generation.value
  let range = { first: 0, last: 0 }

  const pageOf = (index: number): number => Math.floor(index / pageSize)

  function rowAt(index: number): T | undefined {
    void revision.value
    return pages.get(pageOf(index))?.[index % pageSize]
  }

  /**
   * Ids for an inclusive index range, chunked to the id page ceiling.
   *
   * Sequential, and it stops when the predicate changes: the chunks are only
   * useful in order, and a changed predicate makes every remaining one describe
   * a different list.
   */
  async function fetchIdRange(first: number, last: number): Promise<number[]> {
    const requested = generation.value
    const ids: number[] = []

    for (let offset = first; offset <= last; offset += idPageSize) {
      const limit = Math.min(idPageSize, last - offset + 1)
      const result = await deps.fetchIdPage({ ...filters.value, offset, limit })
      if (requested !== generation.value) return ids
      ids.push(...result.ids)
      // A short page means the facet ran out before `last` did.
      if (result.ids.length < limit) break
    }

    return ids
  }

  const selection = createIndexedSelection({
    idAt: (index) => rowAt(index)?.id,
    fetchIdRange,
    /**
     * A selection filtered by itself. Main returns the members that still exist
     * under the current predicate, in list order — which is both the ordering
     * `resolveSelection` promises and the survivor set `pruneSelection` needs.
     */
    orderIds: async (ids) => {
      const result = await deps.fetchIdPage({
        ...filters.value,
        [deps.dimension]: [...ids],
        offset: 0,
        limit: idPageSize
      })
      return result.ids
    },
    ordering: () => generation.value,
    total: () => total.value
  })

  /**
   * This window's contribution to the browse filter, `undefined` only when
   * nothing is selected.
   *
   * A selection covering every row is *not* the same predicate as no selection,
   * which is the trap this deliberately does not fall into. A facet lists the
   * artists and albums that exist, so a track with no artist tag appears in no
   * row of the artist pane at all — selecting all 1,386 artists therefore means
   * 2,940 tracks, while sending no filter means 3,000. Eliding the "everything"
   * case would silently add the untagged tracks back, and in a library with a
   * single artist it would make selecting that artist do nothing whatsoever.
   *
   * The cost of always sending the ids is one integer per selected row on the
   * queries behind it, bounded by `MAX_FILTER_IDS` and only paid by a user who
   * asked for a selection that large.
   */
  let lastFilterKey = ''
  let lastFilterIds: number[] | undefined

  const filterIds = computed<number[] | undefined>(() => {
    const ids =
      selection.count.value === 0 ? undefined : [...selection.ids.value].sort((a, b) => a - b)

    // Identity is stable while the contents are, because the panes downstream
    // watch this value rather than diffing it: a fresh array on every evaluation
    // would make the album pane re-query on every unrelated change here.
    const key = ids?.join(',') ?? ''
    if (key !== lastFilterKey || (ids === undefined) !== (lastFilterIds === undefined)) {
      lastFilterKey = key
      lastFilterIds = ids
    }
    return lastFilterIds
  })

  function evictDistantPages(): void {
    if (pages.size <= maxCachedPages) return
    const firstPage = pageOf(range.first)
    const lastPage = pageOf(range.last)
    const distance = (page: number): number =>
      page < firstPage ? firstPage - page : page > lastPage ? page - lastPage : 0
    for (const page of [...pages.keys()].sort((a, b) => distance(b) - distance(a))) {
      if (pages.size <= maxCachedPages || distance(page) === 0) break
      pages.delete(page)
    }
  }

  async function loadPage(page: number): Promise<void> {
    if (pending.has(page) || (presentingGeneration === generation.value && pages.has(page))) return
    const requested = generation.value
    pending.add(page)
    loading.value = true

    try {
      const result = await deps.fetchPage({
        ...filters.value,
        offset: page * pageSize,
        limit: pageSize
      })
      if (requested !== generation.value) return

      if (presentingGeneration !== requested) {
        pages.clear()
        presentingGeneration = requested
      }
      total.value = result.total
      pages.set(page, result.items)
      selection.adoptPage(result.items, page, pageSize)
      evictDistantPages()
      error.value = null
      revision.value++
    } catch (cause) {
      if (requested !== generation.value) return
      error.value = cause instanceof Error ? cause.message : 'Could not read this facet.'
    } finally {
      if (requested === generation.value) {
        pending.delete(page)
        loading.value = pending.size > 0
      }
    }
  }

  function ensureRange(first: number, last: number): void {
    range = { first: Math.max(0, first), last: Math.max(0, last) }
    for (let page = pageOf(range.first); page <= pageOf(range.last); page++) {
      if (total.value > 0 && page * pageSize >= total.value) break
      void loadPage(page)
    }
  }

  function invalidate(): void {
    generation.value++
    pending.clear()
    loading.value = true
    // Membership survives; positions do not. A changed predicate reorders this
    // facet, so every index the selection holds now names a different row.
    selection.invalidateIndices()
    ensureRange(range.first, range.last)
  }

  function setFilters(next: LibraryBrowseFilters): void {
    filters.value = plainBrowseFilters(next)
    invalidate()
  }

  function reload(): void {
    invalidate()
  }

  /**
   * Drops selected rows that the current predicate no longer contains.
   *
   * Called when a dimension *above* this one narrows — pick a second artist and
   * the albums of the first that they did not both record are gone from the pane,
   * so leaving them selected would filter the song list by rows the user can no
   * longer see or untick.
   *
   * A failure leaves the selection alone. That is the safe direction: keeping a
   * stale tick is a cosmetic wrong that the next successful prune corrects, while
   * dropping ids on a failed query silently discards the user's selection.
   */
  async function pruneSelection(): Promise<void> {
    if (selection.count.value === 0) return
    const requested = generation.value
    try {
      const surviving = await selection.resolveSelection()
      if (requested !== generation.value) return
      selection.retain(surviving)
    } catch {
      // Intentionally silent: see above.
    }
  }

  /** Applies a navigation key. Returns the new focus index, or `null` if not ours. */
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

  function select(index: number, intent: SelectionIntent): Promise<void> {
    return selection.apply(index, intent)
  }

  return {
    filters,
    total,
    loading,
    error,
    generation,
    pageSize,
    rowAt,
    ensureRange,
    setFilters,
    reload,
    filterIds,
    pruneSelection,
    select,
    moveFocus,
    commitFocus,
    selectedIds: selection.ids,
    selectionCount: selection.count,
    selectionResolving: selection.resolving,
    focusIndex: selection.focusIndex,
    isSelected: selection.isSelected,
    isSelectedAt: selection.isSelectedAt,
    clearSelection: selection.clear,
    resolveSelection: selection.resolveSelection,
    cachedPageCount: (): number => pages.size
  }
}

export type FacetWindow<T extends { id: number }> = ReturnType<typeof createFacetWindow<T>>
