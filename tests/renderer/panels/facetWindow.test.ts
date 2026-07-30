import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import type { ListFacetIdsQuery, ListFacetsQuery } from '../../../src/shared/library'
import { createFacetWindow } from '../../../src/renderer/panels/facetWindow'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

interface Row {
  id: number
  name: string
}

/** Facet row at an index: ids are one-based so they never collide with indices. */
const rowAt = (index: number): Row => ({ id: index + 1, name: `Artist ${index + 1}` })

/**
 * A facet of `total` rows in a fixed order, with the id endpoint answering from
 * the same order — which is the contract the two share in main.
 *
 * `survives` models main dropping selected rows that the current predicate no
 * longer contains, the only thing pruning can be tested against.
 */
function syntheticFacet(
  options: { total?: number; survives?: (id: number) => boolean; pageSize?: number } = {}
) {
  const total = options.total ?? 10_000
  const calls: ListFacetsQuery[] = []
  const idCalls: ListFacetIdsQuery[] = []

  const model = createFacetWindow<Row>({
    dimension: 'artistIds',
    pageSize: options.pageSize ?? 100,
    maxCachedPages: 3,
    idPageSize: 500,
    fetchPage: async (query) => {
      calls.push(query)
      return {
        items: Array.from({ length: Math.min(query.limit, total - query.offset) }, (_, index) =>
          rowAt(query.offset + index)
        ),
        total
      }
    },
    fetchIdPage: async (query) => {
      idCalls.push(query)
      // A selection passed as its own filter is the pruning call: answer with the
      // members that survive, in list order, exactly as the store would.
      if (query.artistIds) {
        const surviving = query.artistIds
          .filter((id) => (options.survives ?? (() => true))(id))
          .sort((a, b) => a - b)
        return { ids: surviving, total }
      }
      return {
        ids: Array.from(
          { length: Math.min(query.limit, total - query.offset) },
          (_, index) => rowAt(query.offset + index).id
        ),
        total
      }
    }
  })

  return { model, calls, idCalls }
}

describe('createFacetWindow', () => {
  /**
   * A filter that has been through a reactive store still has to cross IPC.
   *
   * Electron clones every request, and a `Proxy` cannot be cloned — so the
   * symptom of getting this wrong is not a subtly wrong query but "An object
   * could not be cloned" the first time a selection is non-empty. The control
   * assertion is deliberate: without it this test would keep passing if the
   * proxying ever stopped happening for an unrelated reason.
   */
  it('sends filters that survive structured cloning', async () => {
    const { model, calls, idCalls } = syntheticFacet({ total: 200 })
    const store = reactive({ filters: { artistIds: [12, 13] } })
    expect(() => structuredClone(store.filters)).toThrow()

    model.setFilters(store.filters)
    model.ensureRange(0, 20)
    await flush()
    await model.select(0, 'replace')
    await model.select(150, 'range')

    expect(() => structuredClone(calls.at(-1))).not.toThrow()
    expect(() => structuredClone(idCalls.at(-1))).not.toThrow()
    expect(calls.at(-1)?.artistIds).toEqual([12, 13])
  })

  it('holds a bounded number of pages across a large facet', async () => {
    const { model } = syntheticFacet()

    for (let first = 0; first < 10_000; first += 500) {
      model.ensureRange(first, first + 20)
      await flush()
      expect(model.cachedPageCount()).toBeLessThanOrEqual(3)
    }
  })

  it('keeps good rows visible while replacing them with a new predicate', async () => {
    let release: () => void = () => {}
    const model = createFacetWindow<Row>({
      dimension: 'artistIds',
      fetchPage: async (query) => {
        if (query.rootId === 2) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return { items: [{ id: 1, name: query.rootId === 2 ? 'new' : 'old' }], total: 1 }
      },
      fetchIdPage: async () => ({ ids: [1], total: 1 })
    })

    model.ensureRange(0, 0)
    await flush()
    expect(model.rowAt(0)?.name).toBe('old')

    model.setFilters({ rootId: 2 })
    await flush()
    expect(model.loading.value).toBe(true)
    expect(model.rowAt(0)?.name).toBe('old')

    release()
    await flush()
    expect(model.rowAt(0)?.name).toBe('new')
  })

  it('discards an out-of-order response after filters change', async () => {
    const releases = new Map<number, () => void>()
    const calls: ListFacetsQuery[] = []
    const model = createFacetWindow<Row>({
      dimension: 'artistIds',
      fetchPage: async (query) => {
        calls.push(query)
        const root = query.rootId ?? 0
        if (root === 1) {
          await new Promise<void>((resolve) => releases.set(root, resolve))
        }
        return { items: [{ id: root, name: `root ${root}` }], total: 1 }
      },
      fetchIdPage: async () => ({ ids: [], total: 0 })
    })

    model.setFilters({ rootId: 1 })
    model.setFilters({ rootId: 2 })
    await flush()
    expect(model.rowAt(0)?.id).toBe(2)

    releases.get(1)?.()
    await flush()
    expect(model.rowAt(0)?.id).toBe(2)
    expect(calls.map((call) => call.rootId)).toEqual([1, 2])
  })

  it('resolves a range spanning unloaded pages without loading them', async () => {
    const { model, calls } = syntheticFacet()

    model.ensureRange(0, 20)
    await flush()
    await model.select(0, 'replace')
    const pagesLoadedBefore = calls.length

    await model.select(899, 'range')

    expect(model.selectionCount.value).toBe(900)
    expect(model.isSelected(500)).toBe(true)
    // The whole point: a 900-row range cost id requests, not row requests.
    expect(calls.length).toBe(pagesLoadedBefore)
    expect(model.cachedPageCount()).toBeLessThanOrEqual(3)
  })

  it('measures every range from the anchor, so an overshoot is correctable', async () => {
    const { model } = syntheticFacet()

    model.ensureRange(0, 100)
    await flush()
    await model.select(10, 'replace')
    await model.select(60, 'range')
    expect(model.selectionCount.value).toBe(51)

    await model.select(20, 'range')
    expect(model.selectionCount.value).toBe(11)
    expect(model.isSelected(rowAt(10).id)).toBe(true)
    expect(model.isSelected(rowAt(60).id)).toBe(false)
  })

  it('keeps a disjoint selection under Ctrl and adds a span under Ctrl+Shift', async () => {
    const { model } = syntheticFacet()

    model.ensureRange(0, 100)
    await flush()
    await model.select(1, 'replace')
    await model.select(5, 'toggle')
    expect(model.selectionCount.value).toBe(2)

    await model.select(9, 'extend')
    // The span from the anchor at 5 through 9, on top of the row at 1.
    expect(model.selectionCount.value).toBe(6)
    expect(model.isSelected(rowAt(1).id)).toBe(true)
  })

  it('sends a filter for every selection, including one covering the whole facet', async () => {
    const { model } = syntheticFacet({ total: 3, pageSize: 100 })

    model.ensureRange(0, 2)
    await flush()
    // Only an empty selection means "no constraint".
    expect(model.filterIds.value).toBeUndefined()

    await model.select(0, 'replace')
    expect(model.filterIds.value).toEqual([1])

    await model.select(2, 'range')
    expect(model.selectionCount.value).toBe(3)
    // Emphatically not `undefined`. A facet lists the rows that exist, so tracks
    // with no artist or album tag appear in none of them — selecting every row
    // excludes those tracks, while sending no filter includes them. Treating the
    // two as the same predicate makes selecting the only artist in a small
    // library do nothing at all.
    expect(model.filterIds.value).toEqual([1, 2, 3])
  })

  it('filters on the only row in a one-row facet', async () => {
    // The regression that made this rule wrong in the first place: a library with
    // one artist, where selecting that artist has to narrow the songs to it
    // rather than reading as "everything is selected, so filter by nothing".
    const { model } = syntheticFacet({ total: 1 })

    model.ensureRange(0, 0)
    await flush()
    await model.select(0, 'replace')

    expect(model.filterIds.value).toEqual([1])
  })

  it('keeps one array identity while a selection is unchanged', async () => {
    const { model } = syntheticFacet({ total: 200 })

    model.ensureRange(0, 100)
    await flush()
    await model.select(0, 'replace')
    const first = model.filterIds.value

    // Scrolling reports the same total again, which is enough to re-evaluate the
    // computed. The panes downstream watch this value, so a new array here would
    // be a re-query there.
    model.ensureRange(100, 150)
    await flush()

    expect(model.filterIds.value).toBe(first)

    await model.select(1, 'toggle')
    expect(model.filterIds.value).not.toBe(first)
    expect(model.filterIds.value).toEqual([1, 2])
  })

  it('prunes a selection to the rows a narrowed predicate still contains', async () => {
    const { model } = syntheticFacet({ total: 200, survives: (id) => id % 2 === 1 })

    model.ensureRange(0, 100)
    await flush()
    await model.select(0, 'replace')
    await model.select(5, 'range')
    expect(model.selectionCount.value).toBe(6)

    await model.pruneSelection()

    expect([...model.selectedIds.value].sort((a, b) => a - b)).toEqual([1, 3, 5])
  })

  it('keeps membership across a predicate change and re-finds the focused row', async () => {
    // Under the narrowed root the facet loses its first row, so every surviving
    // row moves up one — the case where a remembered index would name the wrong
    // artist rather than merely a stale one.
    const model = createFacetWindow<Row>({
      dimension: 'artistIds',
      pageSize: 100,
      fetchPage: async (query) => ({
        items: Array.from({ length: query.limit }, (_, index) =>
          rowAt(query.offset + index + (query.rootId === 7 ? 1 : 0))
        ),
        total: 200
      }),
      fetchIdPage: async () => ({ ids: [], total: 200 })
    })

    model.ensureRange(0, 100)
    await flush()
    await model.select(4, 'replace')
    expect(model.focusIndex.value).toBe(4)

    model.setFilters({ rootId: 7 })
    // Dropped the instant the predicate changes: until a page arrives, no index
    // this module holds describes a known row.
    expect(model.focusIndex.value).toBe(null)

    await flush()

    // The id the user chose is still chosen, and the focus followed the row to
    // its new position rather than staying on a number.
    expect(model.selectionCount.value).toBe(1)
    expect(model.isSelected(rowAt(4).id)).toBe(true)
    expect(model.focusIndex.value).toBe(3)
  })

  it('leaves a selection alone when pruning fails', async () => {
    const model = createFacetWindow<Row>({
      dimension: 'artistIds',
      fetchPage: async () => ({ items: [rowAt(0)], total: 1 }),
      fetchIdPage: async (query) => {
        if (query.artistIds) throw new Error('main is unavailable')
        return { ids: [rowAt(0).id], total: 1 }
      }
    })

    model.ensureRange(0, 0)
    await flush()
    await model.select(0, 'replace')
    expect(model.selectionCount.value).toBe(1)

    await model.pruneSelection()

    // Dropping ids on a failed query would discard the user's work silently.
    expect(model.selectionCount.value).toBe(1)
  })
})
