import { ref } from 'vue'
import { MAX_FACET_PAGE, type LibraryBrowseFilters, type ListFacetsQuery } from '@shared/library'

export const FACET_PAGE_SIZE = 100
export const MAX_CACHED_FACET_PAGES = 12

export interface FacetPage<T> {
  items: T[]
  total: number
}

export interface FacetWindowDeps<T> {
  fetchPage: (query: ListFacetsQuery) => Promise<FacetPage<T>>
  pageSize?: number
  maxCachedPages?: number
}

/**
 * Bounded, generation-safe window for an artist or album facet.
 *
 * It retains the last good rows until the first page for a changed predicate
 * arrives. That makes an instant search feel continuous without permitting a
 * late response from the previous predicate into the new result.
 */
export function createFacetWindow<T>(deps: FacetWindowDeps<T>) {
  const pageSize = deps.pageSize ?? FACET_PAGE_SIZE
  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > MAX_FACET_PAGE) {
    throw new RangeError(`pageSize must be an integer between 1 and ${MAX_FACET_PAGE}.`)
  }
  const maxCachedPages = Math.max(1, deps.maxCachedPages ?? MAX_CACHED_FACET_PAGES)

  const filters = ref<LibraryBrowseFilters>({})
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

  function setFilters(next: LibraryBrowseFilters): void {
    filters.value = { ...next }
    generation.value++
    pending.clear()
    loading.value = true
    ensureRange(range.first, range.last)
  }

  function reload(): void {
    generation.value++
    pending.clear()
    loading.value = true
    ensureRange(range.first, range.last)
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
    cachedPageCount: (): number => pages.size
  }
}

export type FacetWindow<T> = ReturnType<typeof createFacetWindow<T>>
