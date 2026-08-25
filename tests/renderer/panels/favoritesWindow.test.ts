import { describe, expect, it, vi } from 'vitest'
import type {
  ListFavoriteIdsQuery,
  ListFavoriteIdsResult,
  ListFavoritesQuery,
  ListFavoritesResult
} from '../../../src/shared/favorites'
import type { Track } from '../../../src/shared/library'
import { createFavoritesWindow } from '../../../src/renderer/panels/favoritesWindow'

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

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
    favorite: true,
    artwork: { small: 'oscine://artwork/missing/small', large: 'oscine://artwork/missing/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}

/**
 * A collection of `total` favorites, where the row at position `n` holds the
 * track whose id is `n`.
 *
 * That identity is the whole fixture: the window keys its selection by
 * `tracks.id`, so a test can say "positions 3 to 5 are selected" by naming three
 * numbers and mean both things at once. The playlist window's fixture cannot do
 * that, and the difference is exactly D18's — there, a position and a row
 * identity are two different numbers because D12 makes them two different facts.
 */
function collection(total = 500, pageSize = 100) {
  let size = total
  const pageQueries: ListFavoritesQuery[] = []
  const idQueries: ListFavoriteIdsQuery[] = []

  const fetchPage = vi.fn(async (query: ListFavoritesQuery): Promise<ListFavoritesResult> => {
    pageQueries.push({ ...query })
    return {
      tracks: Array.from(
        { length: Math.max(0, Math.min(query.limit, size - query.offset)) },
        (_, i) => track(query.offset + i)
      ),
      total: size
    }
  })

  const fetchIdPage = vi.fn(async (query: ListFavoriteIdsQuery): Promise<ListFavoriteIdsResult> => {
    idQueries.push({ ...query })
    return {
      ids: Array.from(
        { length: Math.max(0, Math.min(query.limit, size - query.offset)) },
        (_, i) => query.offset + i
      ),
      total: size
    }
  })

  const model = createFavoritesWindow({ fetchPage, fetchIdPage, pageSize, idPageSize: 1000 })
  return {
    model,
    fetchPage,
    fetchIdPage,
    pageQueries,
    idQueries,
    resize: (next: number): void => {
      size = next
    }
  }
}

describe('the favorites window', () => {
  it('pages the collection and reports its total', async () => {
    const c = collection(500)
    c.model.ensureRange(0, 5)
    await flush()

    expect(c.model.total.value).toBe(500)
    expect(c.model.rowAt(0)?.id).toBe(0)
    expect(c.model.rowAt(4)?.id).toBe(4)
    // One page for six rows, not six requests.
    expect(c.fetchPage).toHaveBeenCalledTimes(1)
  })

  /**
   * The window's whole reason to exist beside its two siblings. Not an incidental
   * property of the fixture — `resolveSelection` is what `favorites.remove` and
   * the queue verbs are handed, and both take track ids.
   */
  it('speaks track identity, not entry identity', async () => {
    const c = collection(500)
    expect(c.model.rowIdentity).toBe('track')

    c.model.ensureRange(0, 5)
    await flush()
    await c.model.selectAt(2, 'replace')

    expect([...c.model.selectedIds.value]).toEqual([2])
    expect(await c.model.resolveSelection()).toEqual([2])
  })

  /**
   * A Shift-range across rows the pane never drew has to go to main as ids, and
   * must not leave the rows it passed over in the page cache. Same bargain both
   * siblings strike, and the reason `fetchIdPage` is a separate dependency.
   */
  it('resolves a range past the loaded pages without caching rows', async () => {
    const c = collection(500)
    c.model.ensureRange(0, 5)
    await flush()
    const pagesBefore = c.model.cachedPageCount()

    await c.model.selectAt(0, 'replace')
    await c.model.selectAt(430, 'range')

    expect(c.model.selectionCount.value).toBe(431)
    expect(c.model.cachedPageCount()).toBe(pagesBefore)
    expect(c.fetchIdPage).toHaveBeenCalled()
  })

  /**
   * A heart clicked anywhere inserts a row at the top and moves every row below
   * it. Membership is the operator's and survives; the positions do not.
   */
  it('reloads under a new generation and keeps which tracks are selected', async () => {
    const c = collection(500)
    c.model.ensureRange(0, 5)
    await flush()
    await c.model.selectAt(3, 'replace')

    const before = c.model.ordering.value
    c.model.reload()
    await flush()

    expect(c.model.ordering.value).toBeGreaterThan(before)
    expect([...c.model.selectedIds.value]).toEqual([3])
  })

  it('forgets un-favorited tracks so the selection count matches the rows', async () => {
    const c = collection(500)
    c.model.ensureRange(0, 5)
    await flush()
    await c.model.selectAt(1, 'replace')
    await c.model.selectAt(2, 'toggle')
    expect(c.model.selectionCount.value).toBe(2)

    c.model.forget([2])

    expect(c.model.selectionCount.value).toBe(1)
    expect([...c.model.selectedIds.value]).toEqual([1])
  })

  /**
   * The empty collection is a *state*, not a failure — the property the pinned
   * rail entry depends on. Nothing errors, nothing is left half-loaded, and the
   * window goes on being a window.
   */
  it('reports an empty collection without erroring', async () => {
    const c = collection(0)
    c.model.ensureRange(0, 5)
    await flush()

    expect(c.model.total.value).toBe(0)
    expect(c.model.error.value).toBeNull()
    expect(c.model.rowAt(0)).toBeUndefined()
    expect(c.model.selectionCount.value).toBe(0)
  })

  /** Un-hearting the last one empties the collection and breaks nothing. */
  it('survives its last row being removed', async () => {
    const c = collection(1)
    c.model.ensureRange(0, 5)
    await flush()
    expect(c.model.total.value).toBe(1)

    c.model.forget([0])
    c.resize(0)
    c.model.reload()
    await flush()

    expect(c.model.total.value).toBe(0)
    expect(c.model.error.value).toBeNull()
    expect(c.model.selectionCount.value).toBe(0)
  })

  /**
   * D18's accepted cost, asserted rather than merely commented: there is no
   * column that could reorder this collection, so the list draws inert headers.
   */
  it('has no sortable column and no album runs', () => {
    const c = collection(500)
    expect(c.model.sort).toBeNull()
    expect(c.model.groups.value).toEqual([])
    expect(c.model.scrollKey.value).toBe('favorites')
  })

  it('reads a contiguous span for playback without searching', async () => {
    const c = collection(500, 100)
    const rows = await c.model.tracksInRange(10, 14)

    expect(rows.map((row) => row.id)).toEqual([10, 11, 12, 13, 14])
    expect(c.pageQueries.at(-1)).toEqual({ offset: 10, limit: 5 })
  })
})
