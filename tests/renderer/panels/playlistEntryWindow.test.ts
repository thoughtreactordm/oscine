import { describe, expect, it, vi } from 'vitest'
import { createPlaylistEntryWindow } from '../../../src/renderer/panels/playlistEntryWindow'
import type { Track } from '../../../src/shared/library'
import type {
  ListPlaylistEntriesQuery,
  ListPlaylistEntriesResult,
  ListPlaylistEntryIdsQuery,
  ListPlaylistEntryIdsResult,
  PlaylistEntry
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
}

function source(total: number): Source {
  let pageRequests = 0
  let idRequests = 0
  return {
    fetchPage: (query) => {
      pageRequests += 1
      const entries: PlaylistEntry[] = []
      for (let index = query.offset; index < Math.min(total, query.offset + query.limit); index++) {
        entries.push(entry(index))
      }
      return Promise.resolve({ entries, total })
    },
    fetchIdPage: (query) => {
      idRequests += 1
      const ids: number[] = []
      for (let index = query.offset; index < Math.min(total, query.offset + query.limit); index++) {
        ids.push(entry(index).id)
      }
      return Promise.resolve({ ids, total })
    },
    pageRequests: () => pageRequests,
    idRequests: () => idRequests
  }
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

    // `null` is what tells `TrackList` its headers are inert. A pane that could
    // re-sort the view would be offering an order the store cannot express and a
    // reorder drag could not be interpreted against.
    expect(window.sort).toBeNull()
    expect(window.groups).toEqual([])
    expect('setSort' in window).toBe(false)
  })

  it('names the scroll memory after the playlist, not the predicate', () => {
    const window = createPlaylistEntryWindow(source(10))

    expect(window.scrollKey.value).toBe('playlist:none')
    window.setPlaylist(12)
    expect(window.scrollKey.value).toBe('playlist:12')
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
