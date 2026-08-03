import { describe, expect, it, vi } from 'vitest'
import { createPlaylistEntryWindow } from '../../../src/renderer/panels/playlistEntryWindow'
import type { Track, TrackGroup } from '../../../src/shared/library'
import type {
  ListPlaylistEntriesQuery,
  ListPlaylistEntriesResult,
  ListPlaylistEntryGroupsResult,
  ListPlaylistEntryIdsQuery,
  ListPlaylistEntryIdsResult,
  PlaylistEntry,
  PlaylistEntryOrder
} from '../../../src/shared/playlists'

/**
 * The contents pane's window, against a synthetic playlist.
 *
 * The interesting cases are all about identity: D12 makes the same `track_id`
 * legal twice, so the fixture below deliberately builds a playlist where every
 * fourth entry repeats an earlier track. An implementation that keyed anything
 * off `track.id` passes the paging tests and fails every selection one.
 */

function track(id: number): Track {
  return {
    id,
    rootId: 1,
    title: `Song ${id}`,
    artist: 'Artist',
    album: 'Album',
    albumArtist: null,
    trackNo: null,
    discNo: null,
    year: null,
    durationSec: 100,
    codec: 'flac',
    encodedBytes: 1_000_000,
    sampleRateHz: 44_100,
    channels: 2,
    bitDepth: 16,
    playCount: 0,
    lastPlayedAt: null,
    artwork: { small: 'fermata://artwork/missing/small', large: 'fermata://artwork/missing/large' },
    rgTrackGainDb: null,
    rgTrackPeak: null,
    rgAlbumGainDb: null,
    rgAlbumPeak: null,
    rgSource: null
  }
}

/** Entry `n` holds track `n % 7` — so most tracks appear more than once. */
function entry(index: number): PlaylistEntry {
  return { id: 1000 + index, track: track(index % 7) }
}

interface Source {
  fetchPage: (query: ListPlaylistEntriesQuery) => Promise<ListPlaylistEntriesResult>
  fetchIdPage: (query: ListPlaylistEntryIdsQuery) => Promise<ListPlaylistEntryIdsResult>
  pageRequests: () => number
  idRequests: () => number
  /** Every ordering the window has asked for, page queries and id queries alike. */
  orders: () => Array<PlaylistEntryOrder | undefined>
}

function source(total: number): Source {
  let pageRequests = 0
  let idRequests = 0
  const orders: Array<PlaylistEntryOrder | undefined> = []
  return {
    fetchPage: (query) => {
      pageRequests += 1
      orders.push(query.order)
      const entries: PlaylistEntry[] = []
      for (let index = query.offset; index < Math.min(total, query.offset + query.limit); index++) {
        entries.push(entry(index))
      }
      return Promise.resolve({ entries, total })
    },
    fetchIdPage: (query) => {
      idRequests += 1
      orders.push(query.order)
      const ids: number[] = []
      for (let index = query.offset; index < Math.min(total, query.offset + query.limit); index++) {
        ids.push(entry(index).id)
      }
      return Promise.resolve({ ids, total })
    },
    pageRequests: () => pageRequests,
    idRequests: () => idRequests,
    orders: () => orders
  }
}

/** Two albums, so a run table has something to say. */
function albumGroups(total: number): ListPlaylistEntryGroupsResult {
  const first = Math.ceil(total / 2)
  const run = (albumId: number, title: string, trackCount: number): TrackGroup => ({
    albumId,
    title,
    albumArtist: 'Artist',
    year: null,
    trackCount,
    artwork: { small: 'fermata://artwork/missing/small', large: 'fermata://artwork/missing/large' }
  })
  return { groups: [run(1, 'A', first), run(2, 'B', total - first)], total }
}

/** Lets every queued page settle. Two ticks: `loadPage` awaits once, then writes. */
async function settle(): Promise<void> {
  for (let round = 0; round < 6; round++) await Promise.resolve()
}

describe('playlist entry window', () => {
  it('pages entries by position and reports the playlist total', async () => {
    const rows = source(10_000)
    const window = createPlaylistEntryWindow({ ...rows, pageSize: 100 })

    window.setPlaylist(7)
    await settle()

    expect(window.total.value).toBe(10_000)
    expect(window.rowAt(0)?.id).toBe(0)
    expect(window.entryAt(0)?.id).toBe(1000)
    // Unloaded, and asking for it is what schedules the page rather than an error.
    expect(window.rowAt(5_000)).toBeUndefined()

    window.ensureRange(5_000, 5_010)
    await settle()
    expect(window.entryIdAt(5_000)).toBe(6000)
  })

  it('holds a bounded window of a 10k playlist rather than the playlist', async () => {
    const rows = source(10_000)
    const window = createPlaylistEntryWindow({ ...rows, pageSize: 100, maxCachedPages: 4 })

    window.setPlaylist(7)
    for (let first = 0; first < 4_000; first += 100) {
      window.ensureRange(first, first + 99)
      await settle()
    }

    expect(window.cachedPageCount()).toBeLessThanOrEqual(4)
    expect(window.total.value).toBe(10_000)
  })

  it('keys the selection by entry id, so one copy of a duplicate track selects alone', async () => {
    const rows = source(20)
    const window = createPlaylistEntryWindow({ ...rows, pageSize: 100 })

    window.setPlaylist(7)
    await settle()

    // Entries 0 and 7 are two rows holding the same track (7 % 7 === 0).
    expect(window.rowAt(0)?.id).toBe(window.rowAt(7)?.id)
    expect(window.entryIdAt(0)).not.toBe(window.entryIdAt(7))

    await window.selectAt(0, 'replace')
    expect(window.isSelectedAt(0)).toBe(true)
    expect(window.isSelectedAt(7)).toBe(false)
    expect(window.selectionCount.value).toBe(1)
  })

  it('resolves a range spanning unloaded rows without putting them in the page cache', async () => {
    const rows = source(10_000)
    const window = createPlaylistEntryWindow({ ...rows, pageSize: 100, idPageSize: 10_000 })

    window.setPlaylist(7)
    await settle()
    const held = window.cachedPageCount()

    await window.selectAt(0, 'replace')
    await window.selectAt(4_999, 'range')

    expect(window.selectionCount.value).toBe(5_000)
    expect(window.cachedPageCount()).toBe(held)
  })

  it('puts an arbitrary selection back into playlist order, not id order', async () => {
    const rows = source(500)
    const window = createPlaylistEntryWindow({ ...rows, pageSize: 100, idPageSize: 200 })

    window.setPlaylist(7)
    await settle()

    // Built bottom-to-top, which is how a user clicking upwards builds one.
    await window.selectAt(40, 'replace')
    await window.selectAt(9, 'toggle')
    await window.selectAt(300, 'toggle')

    await expect(window.resolveSelection()).resolves.toEqual([
      entry(9).id,
      entry(40).id,
      entry(300).id
    ])
  })

  it('keeps which entries are selected across an edit, and drops the removed ones', async () => {
    const rows = source(50)
    const window = createPlaylistEntryWindow({ ...rows, pageSize: 100 })

    window.setPlaylist(7)
    await settle()
    await window.selectAt(2, 'replace')
    await window.selectAt(4, 'toggle')

    // An edit moves rows underneath the pane: positions are stale, membership is
    // not — the rows a user just dragged stay selected where they land.
    window.reload()
    expect(window.selectionCount.value).toBe(2)
    expect(window.focusIndex.value).toBeNull()
    expect(window.anchorIndex.value).toBeNull()

    window.forget([entry(2).id])
    expect(window.selectionCount.value).toBe(1)
    await expect(window.resolveSelection()).resolves.toEqual([entry(4).id])
  })

  it('drops the selection when the viewed tab changes, since entry ids are not per playlist', async () => {
    const rows = source(50)
    const window = createPlaylistEntryWindow({ ...rows, pageSize: 100 })

    window.setPlaylist(7)
    await settle()
    await window.selectAt(3, 'replace')
    expect(window.selectionCount.value).toBe(1)

    window.setPlaylist(8)
    expect(window.selectionCount.value).toBe(0)
    expect(window.playlistId.value).toBe(8)
  })

  it('asks for nothing at all until a playlist is chosen', async () => {
    const rows = source(50)
    const window = createPlaylistEntryWindow({ ...rows, pageSize: 100 })

    window.ensureRange(0, 30)
    await settle()

    expect(rows.pageRequests()).toBe(0)
    expect(rows.idRequests()).toBe(0)
    expect(window.total.value).toBe(0)
  })

  it('has no sort column, because position is the truth here', () => {
    const window = createPlaylistEntryWindow(source(10))

    // `null` is what tells `TrackList` its headers are inert, and it stays null
    // under album ordering: that view is chosen from the grouping preference,
    // not by clicking a column, and position remains the truth underneath.
    expect(window.sort).toBeNull()
    expect(window.groups.value).toEqual([])
    expect('setSort' in window).toBe(false)
  })

  it('names the scroll memory after the playlist, not the predicate', () => {
    const window = createPlaylistEntryWindow(source(10))

    expect(window.scrollKey.value).toBe('playlist:none')
    window.setPlaylist(12)
    expect(window.scrollKey.value).toBe('playlist:12')
  })

  it('sends the ordering on every read, so a range resolves against the rows on screen', async () => {
    const rows = source(500)
    const window = createPlaylistEntryWindow({
      ...rows,
      pageSize: 100,
      idPageSize: 200,
      fetchGroups: () => Promise.resolve(albumGroups(500))
    })

    window.setPlaylist(7)
    await settle()
    // Absent while it is the default, so a position read looks as it always did.
    expect(rows.orders().every((order) => order === undefined)).toBe(true)

    window.setOrder('album')
    await settle()
    window.ensureRange(0, 99)
    await settle()
    await window.selectAt(0, 'replace')
    await window.selectAt(150, 'range')
    await window.resolveSelection()

    // Rows, the ids behind the Shift-range and the ordering walk: one list, or
    // the selection is of rows the operator is not looking at.
    const afterSwitch = rows.orders().slice(rows.orders().indexOf('album'))
    expect(afterSwitch.every((order) => order === 'album')).toBe(true)
    expect(afterSwitch.length).toBeGreaterThan(2)
  })

  it('asks for album runs only under album ordering', async () => {
    const rows = source(40)
    const fetchGroups = vi.fn().mockResolvedValue(albumGroups(40))
    const window = createPlaylistEntryWindow({ ...rows, pageSize: 100, fetchGroups })

    window.setPlaylist(7)
    await settle()
    // A playlist in its stored sequence has no contiguous runs to describe, so
    // asking would be a query per reload for headers nobody draws.
    expect(fetchGroups).not.toHaveBeenCalled()
    expect(window.groups.value).toEqual([])

    window.setOrder('album')
    await settle()
    expect(fetchGroups).toHaveBeenCalledTimes(1)
    expect(window.groups.value.map((group) => group.title)).toEqual(['A', 'B'])

    window.setOrder('position')
    await settle()
    expect(window.groups.value).toEqual([])
  })

  it('re-reads the runs after an edit, since an added track can start a new one', async () => {
    const rows = source(40)
    const fetchGroups = vi.fn().mockResolvedValue(albumGroups(40))
    const window = createPlaylistEntryWindow({ ...rows, pageSize: 100, fetchGroups })

    window.setPlaylist(7)
    window.setOrder('album')
    await settle()
    expect(fetchGroups).toHaveBeenCalledTimes(1)

    window.reload()
    await settle()
    expect(fetchGroups).toHaveBeenCalledTimes(2)
  })

  it('keeps which entries are selected when the ordering changes, and drops the indices', async () => {
    const rows = source(200)
    const window = createPlaylistEntryWindow({
      ...rows,
      pageSize: 100,
      fetchGroups: () => Promise.resolve(albumGroups(200))
    })

    window.setPlaylist(7)
    await settle()
    await window.selectAt(2, 'replace')
    await window.selectAt(4, 'toggle')

    // Re-sorting the view moves every row, exactly as an edit does. The operator
    // picked those two entries and a change of view is not a reason to unpick
    // them — but the positions they were picked at mean nothing now.
    window.setOrder('album')
    expect(window.focusIndex.value).toBeNull()
    expect(window.anchorIndex.value).toBeNull()

    // Asserted before the reload settles, on purpose: indices are re-derived
    // from whatever the new pages hold, and this fixture serves the same rows
    // whichever order is asked for. Membership is the part that has to survive.
    await settle()
    expect(window.selectionCount.value).toBe(2)
    await expect(window.resolveSelection()).resolves.toEqual([entry(2).id, entry(4).id])
  })

  it('falls back to no runs when the group read fails', async () => {
    const rows = source(40)
    const window = createPlaylistEntryWindow({
      ...rows,
      pageSize: 100,
      fetchGroups: vi.fn().mockRejectedValue(new Error('gone'))
    })

    window.setPlaylist(7)
    window.setOrder('album')
    await settle()

    // An ungrouped list is always a correct rendering of the rows; a stale run
    // table is not, and `TrackList` sizes its virtualizer from it.
    expect(window.groups.value).toEqual([])
    expect(window.error.value).toBeNull()
  })

  it('resolves an album run by its span, without disturbing the selection', async () => {
    const rows = source(200)
    const window = createPlaylistEntryWindow({
      ...rows,
      pageSize: 100,
      idPageSize: 200,
      fetchGroups: () => Promise.resolve(albumGroups(200))
    })

    window.setPlaylist(7)
    await settle()
    await window.selectAt(3, 'replace')

    // A run is a contiguous span, so both readers take it directly rather than
    // going anywhere near what happens to be ticked.
    await expect(window.idsInRange(10, 13)).resolves.toEqual([
      entry(10).id,
      entry(11).id,
      entry(12).id,
      entry(13).id
    ])
    await expect(window.tracksInRange(10, 12)).resolves.toEqual([
      entry(10).track,
      entry(11).track,
      entry(12).track
    ])

    // The whole point of resolving by span: the operator's selection is theirs.
    expect(window.selectionCount.value).toBe(1)
    await expect(window.resolveSelection()).resolves.toEqual([entry(3).id])
  })

  it('stops a span read at the end of the playlist rather than inventing rows', async () => {
    const rows = source(12)
    const window = createPlaylistEntryWindow({ ...rows, pageSize: 5, idPageSize: 5 })

    window.setPlaylist(7)
    await settle()

    await expect(window.tracksInRange(10, 40)).resolves.toHaveLength(2)
    await expect(window.idsInRange(10, 40)).resolves.toEqual([entry(10).id, entry(11).id])
    await expect(window.tracksInRange(4, 3)).resolves.toEqual([])
  })

  it('reports a failed read rather than blanking rows that loaded', async () => {
    const rows = source(50)
    const window = createPlaylistEntryWindow({
      ...rows,
      pageSize: 10,
      fetchPage: vi.fn().mockRejectedValue(new Error('gone'))
    })

    window.setPlaylist(7)
    await settle()

    expect(window.error.value).toBe('gone')
    expect(window.loading.value).toBe(false)
  })
})
