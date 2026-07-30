import { describe, expect, it } from 'vitest'
import { computed, ref, watch } from 'vue'
import type { LibraryBrowseFilters } from '@shared/library'
import { createFacetWindow } from '../../../src/renderer/panels/facetWindow'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface Row {
  id: number
  name: string
}
const rowAt = (index: number): Row => ({ id: index + 1, name: `Row ${index + 1}` })

function facet(dimension: 'artistIds' | 'albumIds', total: number) {
  const seen: LibraryBrowseFilters[] = []
  const model = createFacetWindow<Row>({
    dimension,
    pageSize: 100,
    fetchPage: async (query) => {
      seen.push({ ...query })
      return {
        items: Array.from({ length: Math.min(query.limit, total - query.offset) }, (_, index) =>
          rowAt(query.offset + index)
        ),
        total
      }
    },
    fetchIdPage: async (query) => {
      if (query[dimension]) return { ids: [...query[dimension]!], total }
      return {
        ids: Array.from(
          { length: Math.min(query.limit, total - query.offset) },
          (_, index) => rowAt(query.offset + index).id
        ),
        total
      }
    }
  })
  return { model, seen }
}

describe('the Sources predicate chain', () => {
  it('narrows the song predicate when an artist is selected', async () => {
    const artists = facet('artistIds', 500)
    const albums = facet('albumIds', 900)
    const rootId = ref<number | null>(null)

    const artistFilters = computed<LibraryBrowseFilters>(() => ({
      ...(rootId.value === null ? {} : { rootId: rootId.value })
    }))
    const albumFilters = computed<LibraryBrowseFilters>(() => ({
      ...artistFilters.value,
      ...(artists.model.filterIds.value === undefined
        ? {}
        : { artistIds: artists.model.filterIds.value })
    }))
    const currentFilters = computed<LibraryBrowseFilters>(() => ({
      ...albumFilters.value,
      ...(albums.model.filterIds.value === undefined
        ? {}
        : { albumIds: albums.model.filterIds.value })
    }))

    const emitted: LibraryBrowseFilters[] = []
    watch(
      artistFilters,
      (filters) => {
        artists.model.setFilters(filters)
        void artists.model.pruneSelection()
      },
      { immediate: true }
    )
    watch(
      albumFilters,
      (filters) => {
        albums.model.setFilters(filters)
        void albums.model.pruneSelection()
      },
      { immediate: true }
    )
    watch(currentFilters, (filters) => emitted.push({ ...filters }), { immediate: true })

    artists.model.ensureRange(0, 20)
    albums.model.ensureRange(0, 20)
    await flush()
    expect(emitted.at(-1)).toEqual({})

    await artists.model.select(2, 'replace')
    await flush()

    expect(artists.model.selectionCount.value).toBe(1)
    expect(artists.model.filterIds.value).toEqual([3])
    expect(emitted.at(-1)).toEqual({ artistIds: [3] })
    expect(albums.seen.at(-1)?.artistIds).toEqual([3])
  })
})
