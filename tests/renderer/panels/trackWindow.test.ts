import { describe, expect, it } from 'vitest'
import {
  MAX_TRACK_PAGE,
  type ListTracksQuery,
  type ListTracksResult,
  type Track
} from '@shared/library'
import { createTrackWindow, nextSelectionIndex } from '../../../src/renderer/panels/trackWindow'

/**
 * The 100k-row claims the panel makes, checked against a 100k-row library.
 *
 * The library is never materialised: pages are synthesised on request, exactly
 * as SQLite would serve them. That is the point — if the panel ever needed the
 * whole table in memory to do its job, these tests could not run at all.
 */
const LIBRARY_SIZE = 100_000

function syntheticLibrary(total = LIBRARY_SIZE) {
  const calls: ListTracksQuery[] = []

  const fetchPage = async (query: ListTracksQuery): Promise<ListTracksResult> => {
    calls.push({ ...query })

    const tracks: Track[] = []
    const end = Math.min(total, query.offset + query.limit)
    for (let index = query.offset; index < end; index++) {
      // Descending reverses which track sits at which position, so a re-sort
      // genuinely moves the selected row rather than leaving it put.
      const id = query.direction === 'asc' ? index + 1 : total - index
      tracks.push({
        id,
        rootId: 1,
        title: `Track ${id}`,
        artist: `Artist ${id % 2000}`,
        album: `Album ${id % 10000}`,
        albumArtist: null,
        trackNo: (id % 20) + 1,
        discNo: 1,
        year: 2000,
        durationSec: 180 + (id % 120),
        codec: 'flac',
        encodedBytes: 12_000_000,
        sampleRateHz: 44100,
        channels: 2,
        bitDepth: 16,
        rgTrackGainDb: null,
        rgTrackPeak: null,
        rgAlbumGainDb: null,
        rgAlbumPeak: null,
        rgSource: null
      })
    }

    return { tracks, total }
  }

  return { calls, fetchPage }
}

/** Lets every page request that `ensureRange` fired settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createTrackWindow', () => {
  it('learns the row count from the first page and holds only that page', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow({ fetchPage: source.fetchPage })

    win.ensureRange(0, 29)
    await flush()

    expect(win.total.value).toBe(LIBRARY_SIZE)
    expect(source.calls).toEqual([
      { sort: 'artist', direction: 'asc', offset: 0, limit: win.pageSize }
    ])
    expect(win.cachedPageCount()).toBe(1)
    expect(win.rowAt(0)?.id).toBe(1)
    // Far outside the window: absent rather than fetched on the off-chance.
    expect(win.rowAt(50_000)).toBeUndefined()
  })

  it('requests only the pages covering the viewport, however far down the list', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow({ fetchPage: source.fetchPage, pageSize: 200 })

    win.ensureRange(99_970, 99_999)
    await flush()

    expect(source.calls).toEqual([{ sort: 'artist', direction: 'asc', offset: 99_800, limit: 200 }])
    expect(win.rowAt(99_999)?.id).toBe(100_000)
  })

  it('holds a bounded number of rows while scrolling the entire library', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow({
      fetchPage: source.fetchPage,
      pageSize: 200,
      maxCachedPages: 4
    })

    for (let first = 0; first < LIBRARY_SIZE; first += 2_000) {
      win.ensureRange(first, first + 29)
      await flush()
      expect(win.cachedPageCount()).toBeLessThanOrEqual(4)
    }

    // Scrolled past 100k rows; still holding at most 800 of them.
    expect(win.cachedPageCount()).toBeLessThanOrEqual(4)
    expect(win.total.value).toBe(LIBRARY_SIZE)
  })

  it('sends sorting to the query rather than reordering anything it holds', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow({ fetchPage: source.fetchPage, pageSize: 200 })

    win.ensureRange(0, 29)
    await flush()

    win.setSort('title')
    // The cache is dropped synchronously: rows ordered by artist say nothing
    // about where they belong ordered by title.
    expect(win.cachedPageCount()).toBe(0)
    await flush()
    expect(source.calls.at(-1)).toEqual({
      sort: 'title',
      direction: 'asc',
      offset: 0,
      limit: 200
    })

    win.setSort('title')
    await flush()
    expect(source.calls.at(-1)?.direction).toBe('desc')

    win.setSort('album')
    await flush()
    expect(source.calls.at(-1)).toMatchObject({ sort: 'album', direction: 'asc' })
  })

  it('discards a page that was in flight when the ordering changed', async () => {
    let release: () => void = () => {}
    const source = syntheticLibrary()
    const issued: ListTracksQuery[] = []

    const win = createTrackWindow({
      pageSize: 200,
      // The ascending page — the one requested first — is held open until the
      // test lets it go, so it lands after the ordering has already changed.
      fetchPage: async (query) => {
        issued.push({ ...query })
        if (query.direction === 'asc') {
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        return source.fetchPage(query)
      }
    })

    win.ensureRange(0, 29)
    await flush()

    win.setSort('artist')
    await flush()
    release()
    await flush()

    expect(win.cachedPageCount()).toBe(1)
    // Descending puts track 100,000 first. Had the stale ascending response
    // been kept, row 0 would be track 1 — two orderings in one list.
    expect(win.rowAt(0)?.id).toBe(100_000)
    // The stale request also must not have left its page number marked
    // in-flight, or the descending page could never have been requested.
    expect(issued.filter((call) => call.direction === 'desc')).toHaveLength(1)
  })

  it('discards a page that was in flight when browse filters changed', async () => {
    const releases = new Map<string, () => void>()
    const issued: ListTracksQuery[] = []
    const source = syntheticLibrary()
    const win = createTrackWindow({
      fetchPage: async (query) => {
        issued.push({ ...query })
        const search = query.searchText ?? ''
        if (search === 'hemian') {
          await new Promise<void>((resolve) => releases.set(search, resolve))
        }
        const result = await source.fetchPage(query)
        return {
          ...result,
          tracks: result.tracks.map((track) => ({ ...track, title: search || 'All tracks' }))
        }
      }
    })

    win.setFilters({ searchText: 'hemian' })
    await flush()
    win.setFilters({ searchText: 'rhapsody' })
    await flush()
    releases.get('hemian')?.()
    await flush()

    expect(win.rowAt(0)?.title).toBe('rhapsody')
    expect(issued.at(-1)?.searchText).toBe('rhapsody')
    expect(win.cachedPageCount()).toBe(1)
  })

  it('keeps the chosen track across a re-sort and re-adopts its position', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow({ fetchPage: source.fetchPage, pageSize: 200 })

    win.ensureRange(0, 29)
    await flush()
    win.select(0)
    expect(win.selectedId.value).toBe(1)
    expect(win.selectedTrack.value?.id).toBe(1)

    // Reversing the order sends track 1 to the far end of the list.
    win.setSort('artist')
    await flush()
    expect(win.selectedId.value).toBe(1)
    expect(win.selectedIndex.value).toBeNull()

    win.ensureRange(99_970, 99_999)
    await flush()
    expect(win.selectedIndex.value).toBe(99_999)
    expect(win.selectedTrack.value?.id).toBe(1)
  })

  it('fills in the selected track once its page arrives', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow({ fetchPage: source.fetchPage, pageSize: 200 })

    win.ensureRange(0, 29)
    await flush()

    // End: an index far outside anything loaded.
    expect(win.moveSelection('End', 30)).toBe(99_999)
    expect(win.selectedIndex.value).toBe(99_999)
    expect(win.selectedId.value).toBeNull()

    win.ensureRange(99_970, 99_999)
    await flush()
    expect(win.selectedId.value).toBe(100_000)
  })

  it('leaves keys it does not own alone', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow({ fetchPage: source.fetchPage })

    win.ensureRange(0, 29)
    await flush()

    expect(win.moveSelection('Tab', 30)).toBeNull()
    expect(win.moveSelection('a', 30)).toBeNull()
    expect(win.selectedIndex.value).toBeNull()
  })

  it('refuses a page size main would reject', () => {
    const source = syntheticLibrary()
    expect(() =>
      createTrackWindow({ fetchPage: source.fetchPage, pageSize: MAX_TRACK_PAGE + 1 })
    ).toThrow(RangeError)
  })
})

describe('nextSelectionIndex', () => {
  const total = LIBRARY_SIZE

  it('moves one row at a time and stops at both ends', () => {
    expect(nextSelectionIndex('ArrowDown', 5, total, 30)).toBe(6)
    expect(nextSelectionIndex('ArrowUp', 5, total, 30)).toBe(4)
    expect(nextSelectionIndex('ArrowUp', 0, total, 30)).toBe(0)
    expect(nextSelectionIndex('ArrowDown', total - 1, total, 30)).toBe(total - 1)
  })

  it('jumps a viewport at a time, clamped', () => {
    expect(nextSelectionIndex('PageDown', 0, total, 30)).toBe(30)
    expect(nextSelectionIndex('PageUp', 10, total, 30)).toBe(0)
    expect(nextSelectionIndex('PageDown', total - 2, total, 30)).toBe(total - 1)
  })

  it('reaches the ends of a 100k list directly', () => {
    expect(nextSelectionIndex('Home', 50_000, total, 30)).toBe(0)
    expect(nextSelectionIndex('End', 0, total, 30)).toBe(total - 1)
  })

  it('starts at the first row when nothing is selected', () => {
    expect(nextSelectionIndex('ArrowDown', null, total, 30)).toBe(0)
    expect(nextSelectionIndex('ArrowUp', null, total, 30)).toBe(0)
  })

  it('has nowhere to go in an empty list', () => {
    expect(nextSelectionIndex('ArrowDown', null, 0, 30)).toBeNull()
    expect(nextSelectionIndex('End', null, 0, 30)).toBeNull()
  })

  it('ignores keys that are not navigation', () => {
    expect(nextSelectionIndex('Enter', 3, total, 30)).toBeNull()
    expect(nextSelectionIndex('Tab', 3, total, 30)).toBeNull()
  })
})
