import { describe, expect, it, vi } from 'vitest'
import {
  libraryScopeReader,
  materializeSession,
  playlistScopeReader
} from '../../../src/renderer/playback/sessionScope'
import {
  MAX_TRACK_ID_PAGE,
  MAX_TRACK_PAGE,
  type GetTracksByIdsQuery,
  type ListTrackIdsQuery,
  type ListTrackIdsResult,
  type Track
} from '../../../src/shared/library'
import type {
  ListPlaylistEntriesQuery,
  ListPlaylistEntriesResult
} from '../../../src/shared/playlists'

/**
 * Reading a scope in bulk — the §5 amendment's session tier, below the queue.
 *
 * Nothing here builds a queue, a controller or an engine. What is being proved
 * is arithmetic over two IPC verbs: that the ids come from the right window,
 * that they are widened in legal pages, and that an order position survives the
 * round trip so a drained tier knows where to resume.
 */

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
    playCount: 0,
    lastPlayedAt: null,
    favorite: false,
    artwork: { small: 'fermata://artwork/missing/small', large: 'fermata://artwork/missing/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}

/** A library where the row at position `n` is `track(n)` — id and offset agree. */
function libraryHarness(total: number, options: { missing?: number[] } = {}) {
  const missing = new Set(options.missing ?? [])

  const fetchTrackIds = vi.fn(async (query: ListTrackIdsQuery): Promise<ListTrackIdsResult> => ({
    ids: Array.from(
      { length: Math.max(0, Math.min(query.limit, total - query.offset)) },
      (_, i) => query.offset + i
    ),
    total
  }))

  const fetchTracksByIds = vi.fn(async (query: GetTracksByIdsQuery): Promise<Track[]> =>
    query.ids.filter((id) => !missing.has(id)).map(track)
  )

  return {
    fetchTrackIds,
    fetchTracksByIds,
    read: libraryScopeReader({
      fetchTrackIds,
      fetchTracksByIds,
      sort: 'artist',
      direction: 'asc',
      filters: { artistIds: [3, 7] }
    })
  }
}

describe('the session scope', () => {
  describe('the library reader', () => {
    it('reads the wanted window and widens it, carrying the scope into the query', async () => {
      const h = libraryHarness(100)

      const rows = await h.read([4, 5, 6])

      expect([...rows.keys()]).toEqual([4, 5, 6])
      expect(rows.get(5)?.id).toBe(5)
      // The filters are the whole point: a session tier read without them would
      // be the library rather than the facet the operator is playing through.
      expect(h.fetchTrackIds).toHaveBeenCalledTimes(1)
      expect(h.fetchTrackIds.mock.calls[0]?.[0]).toEqual({
        artistIds: [3, 7],
        sort: 'artist',
        direction: 'asc',
        offset: 4,
        limit: 3
      })
      expect(h.fetchTracksByIds).toHaveBeenCalledWith({ ids: [4, 5, 6] })
    })

    it('widens in pages the contract will actually serve', async () => {
      const wanted = Array.from({ length: MAX_TRACK_PAGE + 250 }, (_, i) => i)
      const h = libraryHarness(5000)

      const rows = await h.read(wanted)

      expect(rows.size).toBe(wanted.length)
      // Two widens, neither over the row-page ceiling — and one id call, which
      // is the whole reason the ids and the rows come from different verbs.
      expect(h.fetchTracksByIds).toHaveBeenCalledTimes(2)
      for (const [query] of h.fetchTracksByIds.mock.calls) {
        expect(query.ids.length).toBeLessThanOrEqual(MAX_TRACK_PAGE)
      }
      expect(h.fetchTrackIds).toHaveBeenCalledTimes(1)
    })

    it('pages the id read when a scattered window outruns one id page', async () => {
      // What a shuffled order asks for: positions spread across the whole
      // scope rather than a contiguous run.
      const h = libraryHarness(MAX_TRACK_ID_PAGE * 2)

      const rows = await h.read([1, MAX_TRACK_ID_PAGE + 5])

      expect([...rows.keys()].sort((a, b) => a - b)).toEqual([1, MAX_TRACK_ID_PAGE + 5])
      expect(h.fetchTrackIds).toHaveBeenCalledTimes(2)
      for (const [query] of h.fetchTrackIds.mock.calls) {
        expect(query.limit).toBeLessThanOrEqual(MAX_TRACK_ID_PAGE)
      }
    })

    it('stops at the end of the scope rather than asking past it', async () => {
      const h = libraryHarness(6)

      const rows = await h.read([4, 5, 6, 7, 8])

      expect([...rows.keys()]).toEqual([4, 5])
      expect(h.fetchTrackIds).toHaveBeenCalledTimes(1)
    })

    it('drops a row that went away between the id read and the widen', async () => {
      const h = libraryHarness(10, { missing: [5] })

      const rows = await h.read([4, 5, 6])

      // The same "survivors, not a report" bargain `getTracksByIds` already
      // strikes everywhere else it is used.
      expect([...rows.keys()]).toEqual([4, 6])
    })

    it('asks for nothing when there is nothing to ask for', async () => {
      const h = libraryHarness(10)
      expect((await h.read([])).size).toBe(0)
      expect(h.fetchTrackIds).not.toHaveBeenCalled()
    })
  })

  describe('the playlist reader', () => {
    function playlistHarness(total: number) {
      const fetchEntries = vi.fn(
        async (query: ListPlaylistEntriesQuery): Promise<ListPlaylistEntriesResult> => ({
          entries: Array.from(
            { length: Math.max(0, Math.min(query.limit, total - query.offset)) },
            (_, i) => ({ id: query.offset + i + 1, track: track(1000 + query.offset + i) })
          ),
          total
        })
      )
      return {
        fetchEntries,
        read: playlistScopeReader({ playlistId: 7, fetchEntries })
      }
    }

    it('takes the rows the entries already carry, with no widen', async () => {
      const h = playlistHarness(50)

      const rows = await h.read([2, 3, 4])

      expect([...rows.keys()]).toEqual([2, 3, 4])
      expect(rows.get(3)?.id).toBe(1003)
      expect(h.fetchEntries).toHaveBeenCalledTimes(1)
      expect(h.fetchEntries).toHaveBeenCalledWith({ playlistId: 7, offset: 2, limit: 3 })
    })

    it('stops at the end of the playlist', async () => {
      const h = playlistHarness(4)
      const rows = await h.read([2, 3, 4, 5])
      expect([...rows.keys()]).toEqual([2, 3])
    })
  })

  describe('materializing', () => {
    const identity = (index: number): Promise<number | null> => Promise.resolve(index)

    it('labels every row with the order position it came from', async () => {
      const h = libraryHarness(100)

      const rows = await materializeSession({
        read: h.read,
        baseIndexAt: identity,
        from: 3,
        limit: 4
      })

      // The order position, not the offset within the fill. That is what a
      // drained tier resumes after.
      expect(rows).toEqual([
        { track: track(3), orderIndex: 3 },
        { track: track(4), orderIndex: 4 },
        { track: track(5), orderIndex: 5 },
        { track: track(6), orderIndex: 6 }
      ])
    })

    it('stops at the first position the order does not have', async () => {
      const h = libraryHarness(100)
      const end = 6

      const rows = await materializeSession({
        read: h.read,
        baseIndexAt: (index) => Promise.resolve(index < end ? index : null),
        from: 4,
        limit: 10
      })

      expect(rows.map((row) => row.orderIndex)).toEqual([4, 5])
    })

    it('follows a permutation, so the tier shows the rows that will actually play', async () => {
      // §5 rule 6 as amended: the session tier describes what is going to
      // happen, which under shuffle is the permuted order and not the base one.
      const h = libraryHarness(100)
      const permutation = [0, 40, 10, 70]

      const rows = await materializeSession({
        read: h.read,
        baseIndexAt: (index) => Promise.resolve(permutation[index] ?? null),
        from: 1,
        limit: 3
      })

      expect(rows).toEqual([
        { track: track(40), orderIndex: 1 },
        { track: track(10), orderIndex: 2 },
        { track: track(70), orderIndex: 3 }
      ])
    })

    it('materializes nothing for a non-positive cap', async () => {
      const h = libraryHarness(100)
      expect(
        await materializeSession({ read: h.read, baseIndexAt: identity, from: 1, limit: 0 })
      ).toEqual([])
      expect(h.fetchTrackIds).not.toHaveBeenCalled()
    })
  })
})
