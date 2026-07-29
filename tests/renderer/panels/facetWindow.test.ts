import { describe, expect, it } from 'vitest'
import type { ListFacetsQuery } from '../../../src/shared/library'
import { createFacetWindow } from '../../../src/renderer/panels/facetWindow'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('createFacetWindow', () => {
  it('holds a bounded number of pages across a large facet', async () => {
    const win = createFacetWindow<number>({
      pageSize: 100,
      maxCachedPages: 3,
      fetchPage: async (query) => ({
        items: Array.from({ length: query.limit }, (_, index) => query.offset + index),
        total: 10_000
      })
    })

    for (let first = 0; first < 10_000; first += 500) {
      win.ensureRange(first, first + 20)
      await flush()
      expect(win.cachedPageCount()).toBeLessThanOrEqual(3)
    }
  })

  it('keeps good rows visible while replacing them with a new predicate', async () => {
    let release: () => void = () => {}
    const win = createFacetWindow<string>({
      fetchPage: async (query) => {
        if (query.artistId === 2) {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return { items: [query.artistId === 2 ? 'new' : 'old'], total: 1 }
      }
    })

    win.ensureRange(0, 0)
    await flush()
    expect(win.rowAt(0)).toBe('old')

    win.setFilters({ artistId: 2 })
    await flush()
    expect(win.loading.value).toBe(true)
    expect(win.rowAt(0)).toBe('old')

    release()
    await flush()
    expect(win.rowAt(0)).toBe('new')
  })

  it('discards an out-of-order response after filters change', async () => {
    const releases = new Map<number, () => void>()
    const calls: ListFacetsQuery[] = []
    const win = createFacetWindow<number>({
      fetchPage: async (query) => {
        calls.push(query)
        const artist = query.artistId ?? 0
        if (artist === 1) {
          await new Promise<void>((resolve) => releases.set(artist, resolve))
        }
        return { items: [artist], total: 1 }
      }
    })

    win.setFilters({ artistId: 1 })
    win.setFilters({ artistId: 2 })
    await flush()
    expect(win.rowAt(0)).toBe(2)

    releases.get(1)?.()
    await flush()
    expect(win.rowAt(0)).toBe(2)
    expect(calls.map((call) => call.artistId)).toEqual([1, 2])
  })
})
