import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { createListPlayOrder } from '../../../src/renderer/playback/playOrder'
import type { ListTracksQuery, ListTracksResult, Track } from '../../../src/shared/library'

function track(id: number): Track {
  return {
    id,
    rootId: 1,
    title: `Track ${id}`,
    artist: 'Artist',
    album: 'Album',
    albumArtist: null,
    trackNo: id,
    discNo: null,
    year: null,
    durationSec: 120,
    codec: 'flac',
    encodedBytes: 12_000_000,
    sampleRateHz: 44100,
    channels: 2,
    bitDepth: 16,
    artwork: { small: 'fermata://artwork/missing/small', large: 'fermata://artwork/missing/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}

/** A source of `total` rows, answering any window over them. */
function library(total: number): (query: ListTracksQuery) => Promise<ListTracksResult> {
  return async (query) => ({
    tracks: Array.from(
      { length: Math.max(0, Math.min(query.limit, total - query.offset)) },
      (_, i) => track(query.offset + i)
    ),
    total
  })
}

describe('createListPlayOrder', () => {
  it('resolves a position to the row at that offset', async () => {
    const order = createListPlayOrder({
      fetchPage: library(50),
      sort: 'artist',
      direction: 'asc'
    })

    await expect(order.at(0)).resolves.toMatchObject({ id: 0 })
    await expect(order.at(17)).resolves.toMatchObject({ id: 17 })
  })

  it('asks for exactly one row, under the captured sort', async () => {
    const fetchPage = vi.fn(library(50))
    const order = createListPlayOrder({ fetchPage, sort: 'album', direction: 'desc' })

    await order.at(9)

    expect(fetchPage).toHaveBeenCalledWith({
      sort: 'album',
      direction: 'desc',
      offset: 9,
      limit: 1
    })
  })

  it('captures browse and search filters with the traversal', async () => {
    const fetchPage = vi.fn(library(50))
    const order = createListPlayOrder({
      fetchPage,
      sort: 'album',
      direction: 'asc',
      filters: { rootId: 2, artistIds: [3], albumIds: [4], searchText: 'hemian' }
    })

    await order.at(7)

    expect(fetchPage).toHaveBeenCalledWith({
      rootId: 2,
      artistIds: [3],
      albumIds: [4],
      searchText: 'hemian',
      sort: 'album',
      direction: 'asc',
      offset: 7,
      limit: 1
    })
  })

  it('returns null past the last row rather than throwing', async () => {
    // This is what makes "reaching the end stops cleanly" a non-special case:
    // the end of the order is just an absent row.
    const order = createListPlayOrder({ fetchPage: library(3), sort: 'title', direction: 'asc' })

    await expect(order.at(2)).resolves.toMatchObject({ id: 2 })
    await expect(order.at(3)).resolves.toBeNull()
    await expect(order.at(9_999)).resolves.toBeNull()
  })

  it('returns null for a position that is not a row, without asking main', async () => {
    // Main rejects a negative or fractional offset as `invalid-request`; there
    // is no reason to spend a round trip discovering that.
    const fetchPage = vi.fn(library(10))
    const order = createListPlayOrder({ fetchPage, sort: 'title', direction: 'asc' })

    await expect(order.at(-1)).resolves.toBeNull()
    await expect(order.at(1.5)).resolves.toBeNull()
    expect(fetchPage).not.toHaveBeenCalled()
  })

  /**
   * A filter that has been through a reactive store still has to cross IPC.
   *
   * Electron clones every request, and a `Proxy` cannot be cloned — so the
   * symptom of getting this wrong is not a subtly wrong query but "An object
   * could not be cloned" the first time a selection is non-empty. The control
   * assertion is deliberate: without it this test would keep passing if the
   * proxying ever stopped happening for an unrelated reason.
   */
  it('builds queries that survive structured cloning', async () => {
    const calls: ListTracksQuery[] = []
    const store = reactive({ filters: { artistIds: [3], albumIds: [4] } })
    expect(() => structuredClone(store.filters)).toThrow()

    const order = createListPlayOrder({
      fetchPage: async (query) => {
        calls.push(query)
        return { tracks: [track(1)], total: 1 }
      },
      sort: 'title',
      direction: 'asc',
      filters: store.filters
    })

    await order.at(0)

    expect(() => structuredClone(calls[0])).not.toThrow()
    expect(calls[0]?.artistIds).toEqual([3])
  })

  it('identifies orderings that traverse the same rows', () => {
    const deps = { fetchPage: library(1), sort: 'artist', direction: 'asc' } as const
    const other = { fetchPage: library(1), sort: 'artist', direction: 'desc' } as const

    expect(createListPlayOrder(deps).id).toBe(createListPlayOrder(deps).id)
    expect(createListPlayOrder(deps).id).not.toBe(createListPlayOrder(other).id)
  })
})
