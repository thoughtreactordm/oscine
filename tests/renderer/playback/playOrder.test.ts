import { describe, expect, it, vi } from 'vitest'
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
    bitDepth: 16
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

  it('identifies orderings that traverse the same rows', () => {
    const deps = { fetchPage: library(1), sort: 'artist', direction: 'asc' } as const
    const other = { fetchPage: library(1), sort: 'artist', direction: 'desc' } as const

    expect(createListPlayOrder(deps).id).toBe(createListPlayOrder(deps).id)
    expect(createListPlayOrder(deps).id).not.toBe(createListPlayOrder(other).id)
  })
})
