import { describe, expect, it } from 'vitest'
import {
  MAX_TRACK_ID_PAGE,
  MAX_TRACK_PAGE,
  type ListTrackIdsQuery,
  type ListTrackIdsResult,
  type ListTracksQuery,
  type ListTracksResult,
  type OrderTrackIdsQuery,
  type Track
} from '@shared/library'
import { createTrackWindow, nextFocusIndex } from '../../../src/renderer/panels/trackWindow'

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
  const idCalls: ListTrackIdsQuery[] = []

  // Descending reverses which track sits at which position, so a re-sort
  // genuinely moves the selected row rather than leaving it put.
  const idAt = (index: number, direction: string): number =>
    direction === 'asc' ? index + 1 : total - index
  const positionOf = (id: number, direction: string): number =>
    direction === 'asc' ? id - 1 : total - id

  const fetchPage = async (query: ListTracksQuery): Promise<ListTracksResult> => {
    calls.push({ ...query })

    const tracks: Track[] = []
    const end = Math.min(total, query.offset + query.limit)
    for (let index = query.offset; index < end; index++) {
      const id = idAt(index, query.direction)
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
        artwork: {
          small: 'fermata://artwork/missing/small',
          large: 'fermata://artwork/missing/large'
        },
        rgTrackGainDb: null,
        rgTrackPeak: null,
        rgAlbumGainDb: null,
        rgAlbumPeak: null,
        rgSource: null
      })
    }

    return { tracks, total }
  }

  /**
   * Ids for the same window, without ever building a `Track`.
   *
   * Written as a separate source rather than as `fetchPage(...).map(t => t.id)`
   * on purpose: a range selection that quietly went through the row query would
   * still pass every assertion about *which* rows it selected, and fail the only
   * thing this half of the panel promises.
   */
  const fetchIdPage = async (query: ListTrackIdsQuery): Promise<ListTrackIdsResult> => {
    idCalls.push({ ...query })
    const ids: number[] = []
    const end = Math.min(total, query.offset + query.limit)
    for (let index = query.offset; index < end; index++) ids.push(idAt(index, query.direction))
    return { ids, total }
  }

  const orderIds = async (query: OrderTrackIdsQuery): Promise<number[]> =>
    [...new Set(query.ids)].sort(
      (a, b) => positionOf(a, query.direction) - positionOf(b, query.direction)
    )

  return { calls, idCalls, fetchPage, fetchIdPage, orderIds, idAt, positionOf }
}

/** The three dependencies every window needs, from one synthetic library. */
function deps(
  source: ReturnType<typeof syntheticLibrary>,
  overrides: { pageSize?: number; idPageSize?: number; maxCachedPages?: number } = {}
) {
  return {
    fetchPage: source.fetchPage,
    fetchIdPage: source.fetchIdPage,
    orderIds: source.orderIds,
    ...overrides
  }
}

/** Lets every page request that `ensureRange` fired settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createTrackWindow', () => {
  it('learns the row count from the first page and holds only that page', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source))

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
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.ensureRange(99_970, 99_999)
    await flush()

    expect(source.calls).toEqual([{ sort: 'artist', direction: 'asc', offset: 99_800, limit: 200 }])
    expect(win.rowAt(99_999)?.id).toBe(100_000)
  })

  it('holds a bounded number of rows while scrolling the entire library', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200, maxCachedPages: 4 }))

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
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.ensureRange(0, 29)
    await flush()

    win.setSort('title')
    // The last good page stays mounted while the replacement is pending.
    expect(win.cachedPageCount()).toBe(1)
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
      ...deps(source, { pageSize: 200 }),
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
      ...deps(source),
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

  it('defaults to track number ascending when entering an album', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.setSort('title')
    await flush()
    win.setSort('title')
    await flush()
    expect(win.direction.value).toBe('desc')

    win.setFilters({ artistId: 12, albumId: 34 })
    await flush()

    expect(win.sort.value).toBe('trackNo')
    expect(win.direction.value).toBe('asc')
    expect(source.calls.at(-1)).toMatchObject({
      artistId: 12,
      albumId: 34,
      sort: 'trackNo',
      direction: 'asc'
    })
  })

  it('preserves a manual album sort while other filters change', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.setFilters({ albumId: 34 })
    await flush()
    win.setSort('title')
    await flush()
    win.setFilters({ albumId: 34, searchText: 'hemian' })
    await flush()

    expect(win.sort.value).toBe('title')
    expect(source.calls.at(-1)).toMatchObject({
      albumId: 34,
      searchText: 'hemian',
      sort: 'title',
      direction: 'asc'
    })
  })

  it.each([
    {
      label: 'All Artists',
      selected: { artistId: 12, albumId: 34 },
      all: { albumId: 34 }
    },
    {
      label: 'All Albums',
      selected: { artistId: 12, albumId: 34 },
      all: { artistId: 12 }
    }
  ])('defaults to artist ascending when selecting $label', async ({ selected, all }) => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.setFilters(selected)
    await flush()
    expect(win.sort.value).toBe('trackNo')

    win.setFilters(all)
    await flush()

    expect(win.sort.value).toBe('artist')
    expect(win.direction.value).toBe('asc')
    expect(source.calls.at(-1)).toMatchObject({
      ...all,
      sort: 'artist',
      direction: 'asc'
    })
  })

  it('keeps the focused track across a re-sort and re-adopts its position', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.ensureRange(0, 29)
    await flush()
    await win.selectAt(0, 'replace')
    expect(win.focusId.value).toBe(1)
    expect(win.focusedTrack.value?.id).toBe(1)

    // Reversing the order sends track 1 to the far end of the list.
    win.setSort('artist')
    await flush()
    expect(win.focusId.value).toBe(1)
    expect(win.focusIndex.value).toBeNull()

    win.ensureRange(99_970, 99_999)
    await flush()
    expect(win.focusIndex.value).toBe(99_999)
    expect(win.focusedTrack.value?.id).toBe(1)
  })

  it('fills in the focused track once its page arrives', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.ensureRange(0, 29)
    await flush()

    // End: an index far outside anything loaded.
    expect(win.moveFocus('End', 30)).toBe(99_999)
    expect(win.focusIndex.value).toBe(99_999)
    expect(win.focusId.value).toBeNull()

    win.ensureRange(99_970, 99_999)
    await flush()
    expect(win.focusId.value).toBe(100_000)
  })

  it('leaves keys it does not own alone', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source))

    win.ensureRange(0, 29)
    await flush()

    expect(win.moveFocus('Tab', 30)).toBeNull()
    expect(win.moveFocus('a', 30)).toBeNull()
    expect(win.focusIndex.value).toBeNull()
  })

  it('refuses a page size main would reject', () => {
    const source = syntheticLibrary()
    expect(() => createTrackWindow(deps(source, { pageSize: MAX_TRACK_PAGE + 1 }))).toThrow(
      RangeError
    )
  })

  it('refuses an id page size main would reject', () => {
    const source = syntheticLibrary()
    expect(() => createTrackWindow(deps(source, { idPageSize: MAX_TRACK_ID_PAGE + 1 }))).toThrow(
      RangeError
    )
  })
})

/**
 * Arbitrary multi-selection over a list that is 99.8% not loaded.
 *
 * Every test here checks two things at once: that the right tracks ended up
 * selected, and that finding them out did not make the panel hold rows. The
 * second is the harder guarantee and the reason the id query exists — a range
 * selection that happened to work by loading 10,000 rows would satisfy every
 * assertion about membership and none of the ones about scale.
 */
describe('track selection', () => {
  it('builds and edits a disjoint set with Ctrl', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.ensureRange(0, 29)
    await flush()

    await win.selectAt(3, 'replace')
    await win.selectAt(7, 'toggle')
    await win.selectAt(11, 'toggle')
    expect([...win.selectedIds.value].sort((a, b) => a - b)).toEqual([4, 8, 12])
    expect(win.selectionCount.value).toBe(3)

    // Toggling a selected row removes it and leaves the rest of the set alone.
    await win.selectAt(7, 'toggle')
    expect([...win.selectedIds.value].sort((a, b) => a - b)).toEqual([4, 12])

    // A plain click discards the disjoint set rather than adding to it.
    await win.selectAt(20, 'replace')
    expect([...win.selectedIds.value]).toEqual([21])
  })

  it('resolves a Shift range across 10,000 unloaded rows without loading them', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200, maxCachedPages: 4 }))

    win.ensureRange(0, 29)
    await flush()
    const rowQueries = source.calls.length

    await win.selectAt(0, 'replace')
    await win.selectAt(9_999, 'range')

    expect(win.selectionCount.value).toBe(10_000)
    expect(win.selectedIds.value.has(1)).toBe(true)
    expect(win.selectedIds.value.has(10_000)).toBe(true)
    expect(win.selectedIds.value.has(10_001)).toBe(false)

    // One id request, and not a single extra row request or cached page.
    expect(source.idCalls).toEqual([{ sort: 'artist', direction: 'asc', offset: 0, limit: 10_000 }])
    expect(source.calls).toHaveLength(rowQueries)
    expect(win.cachedPageCount()).toBeLessThanOrEqual(4)
  })

  it('resolves a Shift range in descending order too', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    // 'artist' is already the sort, so one click reverses it.
    win.setSort('artist')
    win.ensureRange(0, 29)
    await flush()
    expect(win.direction.value).toBe('desc')

    await win.selectAt(0, 'replace')
    await win.selectAt(9_999, 'range')

    expect(win.selectionCount.value).toBe(10_000)
    // Descending puts the last track first, so the range is the top of the ids.
    expect(win.selectedIds.value.has(LIBRARY_SIZE)).toBe(true)
    expect(win.selectedIds.value.has(LIBRARY_SIZE - 9_999)).toBe(true)
    expect(win.selectedIds.value.has(LIBRARY_SIZE - 10_000)).toBe(false)
  })

  it('chunks a range to the id page ceiling', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200, idPageSize: 1_000 }))

    win.ensureRange(0, 29)
    await flush()
    await win.selectAt(0, 'replace')
    await win.selectAt(9_999, 'range')

    expect(source.idCalls).toHaveLength(10)
    expect(source.idCalls.map((call) => call.offset)).toEqual([
      0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000, 8_000, 9_000
    ])
    expect(win.selectionCount.value).toBe(10_000)
  })

  it('re-measures every Shift range from the same anchor', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.ensureRange(0, 29)
    await flush()

    await win.selectAt(10, 'replace')
    await win.selectAt(20, 'range')
    expect(win.selectionCount.value).toBe(11)

    // Overshot: the correcting Shift+click must shrink the range, not add to it.
    await win.selectAt(14, 'range')
    expect(win.selectionCount.value).toBe(5)
    expect(win.anchorIndex.value).toBe(10)
  })

  it('adds a second range with Ctrl+Shift instead of replacing the first', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.ensureRange(0, 29)
    await flush()

    await win.selectAt(0, 'replace')
    await win.selectAt(4, 'range')
    // Ctrl moves the anchor without disturbing the first range...
    await win.selectAt(10, 'toggle')
    // ...and Ctrl+Shift extends from there, keeping both spans.
    await win.selectAt(14, 'extend')

    expect([...win.selectedIds.value].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 11, 12, 13, 14, 15
    ])
  })

  it('keeps the selection across a re-sort and a filter round trip', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.ensureRange(0, 29)
    await flush()
    await win.selectAt(0, 'replace')
    await win.selectAt(9, 'range')
    const selected = [...win.selectedIds.value].sort((a, b) => a - b)
    expect(selected).toHaveLength(10)

    // A re-sort moves every one of those rows and must not deselect any of them.
    win.setSort('title')
    // Positions go immediately: until a page arrives, nothing knows where the
    // anchor and focus went. Membership is untouched.
    expect(win.anchorIndex.value).toBeNull()
    expect(win.focusIndex.value).toBeNull()
    expect([...win.selectedIds.value].sort((a, b) => a - b)).toEqual(selected)

    await flush()
    expect([...win.selectedIds.value].sort((a, b) => a - b)).toEqual(selected)
    // …and are re-adopted once the page holding them lands.
    expect(win.anchorIndex.value).toBe(0)

    // Rows hidden by a filter stay selected, and are still selected coming back.
    win.setFilters({ searchText: 'hemian' })
    await flush()
    expect([...win.selectedIds.value].sort((a, b) => a - b)).toEqual(selected)
    win.setFilters({})
    await flush()
    expect([...win.selectedIds.value].sort((a, b) => a - b)).toEqual(selected)
    expect(win.cachedPageCount()).toBeLessThanOrEqual(1)
  })

  it('reads the selection back in list order, in either direction', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.ensureRange(0, 29)
    await flush()
    await win.selectAt(5, 'replace')
    await win.selectAt(1, 'toggle')
    await win.selectAt(9, 'toggle')

    // Selected out of order; resolved in list order regardless.
    expect(await win.resolveSelection()).toEqual([2, 6, 10])

    win.setSort('artist')
    await flush()
    expect(await win.resolveSelection()).toEqual([10, 6, 2])
  })

  it('has an empty ordered selection when nothing is selected', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source))

    expect(await win.resolveSelection()).toEqual([])
    expect(win.selectionCount.value).toBe(0)
  })

  it('walks the list with Ctrl+arrow without disturbing the selection', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.ensureRange(0, 29)
    await flush()

    await win.selectAt(2, 'replace')
    expect(win.moveFocus('ArrowDown', 30, { ctrlKey: true })).toBe(3)
    expect(win.moveFocus('ArrowDown', 30, { ctrlKey: true })).toBe(4)
    await flush()

    expect(win.focusIndex.value).toBe(4)
    expect([...win.selectedIds.value]).toEqual([3])
    expect(win.anchorIndex.value).toBe(2)

    // Ctrl+Space is what commits the row the focus walked to.
    win.commitFocus({ ctrlKey: true })
    await flush()
    expect([...win.selectedIds.value].sort((a, b) => a - b)).toEqual([3, 5])
  })

  it('extends from the anchor with Shift+arrow and replaces with a plain arrow', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.ensureRange(0, 29)
    await flush()

    await win.selectAt(4, 'replace')
    win.moveFocus('ArrowDown', 30, { shiftKey: true })
    win.moveFocus('ArrowDown', 30, { shiftKey: true })
    await flush()
    expect([...win.selectedIds.value].sort((a, b) => a - b)).toEqual([5, 6, 7])

    // A plain arrow collapses the range back to one row.
    win.moveFocus('ArrowDown', 30)
    await flush()
    expect([...win.selectedIds.value]).toEqual([8])
    expect(win.anchorIndex.value).toBe(7)
  })

  it('discards a range that was in flight when the ordering changed', async () => {
    let release: () => void = () => {}
    const source = syntheticLibrary()
    const win = createTrackWindow({
      ...deps(source, { pageSize: 200 }),
      fetchIdPage: async (query) => {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return source.fetchIdPage(query)
      }
    })

    win.ensureRange(0, 29)
    await flush()
    await win.selectAt(0, 'replace')

    const ranged = win.selectAt(9_999, 'range')
    win.setSort('title')
    await flush()
    release()
    await ranged

    // The ids that came back describe the old ordering, so none of them are
    // trustworthy. Only the row selected before the re-sort survives.
    expect([...win.selectedIds.value]).toEqual([1])
  })

  it('clears the selection and the anchor together', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.ensureRange(0, 29)
    await flush()
    await win.selectAt(0, 'replace')
    await win.selectAt(9, 'range')

    win.clearSelection()
    expect(win.selectionCount.value).toBe(0)
    expect(win.anchorIndex.value).toBeNull()
    // Focus is navigation, not selection: clearing one leaves the other.
    expect(win.focusIndex.value).toBe(9)
  })

  it('selects a row the keyboard reached before its page arrived', async () => {
    const source = syntheticLibrary()
    const win = createTrackWindow(deps(source, { pageSize: 200 }))

    win.ensureRange(0, 29)
    await flush()

    expect(win.moveFocus('End', 30)).toBe(LIBRARY_SIZE - 1)
    expect(win.focusId.value).toBeNull()
    await flush()

    // The row was never loaded, so its id came from the id query.
    expect([...win.selectedIds.value]).toEqual([LIBRARY_SIZE])
    expect(source.idCalls.at(-1)).toMatchObject({ offset: LIBRARY_SIZE - 1, limit: 1 })
  })
})

describe('nextFocusIndex', () => {
  const total = LIBRARY_SIZE

  it('moves one row at a time and stops at both ends', () => {
    expect(nextFocusIndex('ArrowDown', 5, total, 30)).toBe(6)
    expect(nextFocusIndex('ArrowUp', 5, total, 30)).toBe(4)
    expect(nextFocusIndex('ArrowUp', 0, total, 30)).toBe(0)
    expect(nextFocusIndex('ArrowDown', total - 1, total, 30)).toBe(total - 1)
  })

  it('jumps a viewport at a time, clamped', () => {
    expect(nextFocusIndex('PageDown', 0, total, 30)).toBe(30)
    expect(nextFocusIndex('PageUp', 10, total, 30)).toBe(0)
    expect(nextFocusIndex('PageDown', total - 2, total, 30)).toBe(total - 1)
  })

  it('reaches the ends of a 100k list directly', () => {
    expect(nextFocusIndex('Home', 50_000, total, 30)).toBe(0)
    expect(nextFocusIndex('End', 0, total, 30)).toBe(total - 1)
  })

  it('starts at the first row when nothing is focused', () => {
    expect(nextFocusIndex('ArrowDown', null, total, 30)).toBe(0)
    expect(nextFocusIndex('ArrowUp', null, total, 30)).toBe(0)
  })

  it('has nowhere to go in an empty list', () => {
    expect(nextFocusIndex('ArrowDown', null, 0, 30)).toBeNull()
    expect(nextFocusIndex('End', null, 0, 30)).toBeNull()
  })

  it('ignores keys that are not navigation', () => {
    expect(nextFocusIndex('Enter', 3, total, 30)).toBeNull()
    expect(nextFocusIndex('Tab', 3, total, 30)).toBeNull()
  })
})
