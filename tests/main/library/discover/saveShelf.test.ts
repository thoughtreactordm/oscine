import { afterEach, describe, expect, it } from 'vitest'
import type {
  DiscoverAlbumItem,
  DiscoverItem,
  DiscoverTrackItem
} from '../../../../src/shared/discover'
import { isFermataError } from '../../../../src/shared/errors'
import { DiscoverEngine, compose } from '../../../../src/main/library/discover/compose'
import {
  expandShelfTrackIds,
  shelfPlaylistName,
  snapshotShelf
} from '../../../../src/main/library/discover/saveShelf'
import { LibraryStore } from '../../../../src/main/library/store'
import { PlaylistStore } from '../../../../src/main/library/playlists/store'
import { DAY_MS } from '../../../../src/main/library/discover/constants'
import {
  NOW,
  addCompleteAlbum,
  addListen,
  addRoot,
  addArtist,
  listenEveryTrack,
  openTempDb,
  rebuild,
  seedCatalog
} from './fixture'

function albumItem(albumId: number, title = `Album ${albumId}`): DiscoverAlbumItem {
  return {
    grain: 'album',
    albumId,
    title,
    artist: null,
    year: null,
    trackCount: 4,
    artworkHash: null,
    why: 'Unplayed · 4 tracks'
  }
}

function trackItem(trackId: number): DiscoverTrackItem {
  return {
    grain: 'track',
    trackId,
    title: `Song ${trackId}`,
    artist: null,
    albumTitle: null,
    artworkHash: null,
    why: 'Hearted · never played'
  }
}

function albumTrackIds(store: LibraryStore, albumId: number): number[] {
  return store.listTrackIds({
    albumIds: [albumId],
    sort: 'trackNo',
    direction: 'asc',
    offset: 0,
    limit: 10_000
  }).ids
}

function playlistTrackIds(playlists: PlaylistStore, playlistId: number): number[] {
  return playlists
    .listEntries({ playlistId, offset: 0, limit: 10_000 })
    .entries.map((entry) => entry.track.id)
}

describe('snapshotShelf', () => {
  it('names the playlist from the shelf title and the result day-key', () => {
    expect(shelfPlaylistName('Built for you', '2024-06-15')).toBe('Built for you · 2024-06-15')
  })

  it('refuses when nothing has been composed yet', () => {
    try {
      snapshotShelf(null, 'for-you')
      expect.unreachable()
    } catch (error) {
      expect(isFermataError(error)).toBe(true)
      if (isFermataError(error)) {
        expect(error.code).toBe('not-found')
        expect(error.message).toBe('Discover has no shelf to save yet.')
      }
    }
  })

  it('refuses a recipe that is not on the last page', () => {
    try {
      snapshotShelf({ dayKey: '2024-06-15', shelves: [] }, 'for-you')
      expect.unreachable()
    } catch (error) {
      expect(isFermataError(error)).toBe(true)
      if (isFermataError(error)) expect(error.code).toBe('not-found')
    }
  })

  it('returns the items from the last result, not a copy that could be recomputed', () => {
    const items: DiscoverItem[] = [albumItem(3)]
    const snapshot = snapshotShelf(
      {
        dayKey: '2024-06-15',
        shelves: [
          {
            id: 'for-you',
            title: 'Built for you',
            hint: 'From what you have been playing.',
            grain: 'album',
            items
          }
        ]
      },
      'for-you'
    )
    expect(snapshot.name).toBe('Built for you · 2024-06-15')
    expect(snapshot.items).toBe(items)
  })
})

describe('expandShelfTrackIds', () => {
  it('keeps track-grain cards as those ids and never asks for an album expansion', () => {
    expect(
      expandShelfTrackIds([trackItem(9), trackItem(4)], () => {
        throw new Error('track-grain shelves must not expand albums')
      })
    ).toEqual([9, 4])
  })

  it('concatenates album expansions in card order', () => {
    const byAlbum: Record<number, number[]> = { 1: [10, 11], 2: [20] }
    expect(
      expandShelfTrackIds(
        [albumItem(1), albumItem(2), trackItem(99)],
        (albumId) => byAlbum[albumId]!
      )
    ).toEqual([10, 11, 20, 99])
  })
})

describe('save against a cached result', () => {
  let close = (): void => {}

  afterEach(() => close())

  it('expands albums in Library disc/track/id order', () => {
    const opened = openTempDb()
    close = opened.close
    const rootId = addRoot(opened.db)
    const artistId = addArtist(opened.db, 'Disc')
    const album = addCompleteAlbum(opened.db, {
      rootId,
      artistId,
      title: 'Sides',
      year: 1999,
      genre: 'Split',
      tracks: 3
    })
    // Three tracks, inserted as disc 1 / track 1, 2, 3. Flip them so disc 2
    // track 1 would sort first if we ordered by track number alone.
    opened.db
      .prepare('UPDATE tracks SET disc_no = 2, track_no = 1 WHERE id = ?')
      .run(album.trackIds[0])
    opened.db
      .prepare('UPDATE tracks SET disc_no = 1, track_no = 2 WHERE id = ?')
      .run(album.trackIds[1])
    opened.db
      .prepare('UPDATE tracks SET disc_no = 1, track_no = 1 WHERE id = ?')
      .run(album.trackIds[2])

    const store = new LibraryStore(opened.db)
    const ids = expandShelfTrackIds([albumItem(album.albumId)], (albumId) =>
      albumTrackIds(store, albumId)
    )
    expect(ids).toEqual([album.trackIds[2], album.trackIds[1], album.trackIds[0]])
  })

  it('writes the cached track ids, and a later compose that would pick differently does not change them', () => {
    const opened = openTempDb()
    close = opened.close
    seedCatalog(opened.db)

    const engine = new DiscoverEngine(opened.db)
    const first = engine.shelves(NOW)
    const forYou = first.shelves.find((shelf) => shelf.id === 'for-you')
    expect(forYou).toBeDefined()
    expect(forYou!.items.length).toBeGreaterThan(0)

    const store = new LibraryStore(opened.db)
    const snapshot = snapshotShelf(engine.lastResult(), 'for-you')
    const savedIds = expandShelfTrackIds(snapshot.items, (albumId) => albumTrackIds(store, albumId))
    expect(savedIds.length).toBeGreaterThan(0)

    const playlists = new PlaylistStore(opened.db)
    const playlist = playlists.create(snapshot.name, NOW)
    playlists.addTracks(playlist.id, savedIds, { at: 'end' }, NOW + 1)
    expect(playlistTrackIds(playlists, playlist.id)).toEqual(savedIds)
    expect(playlist.name).toBe(`Built for you · ${first.dayKey}`)

    // Heavy-rotate every album that landed on the wall so a fresh compose
    // cannot honestly show them on *for-you* again.
    for (const item of forYou!.items) {
      if (item.grain !== 'album') continue
      listenEveryTrack(opened.db, albumTrackIds(store, item.albumId), NOW - DAY_MS)
    }
    rebuild(opened.db)

    const recomposed = compose(opened.db, NOW)
    const nextForYou = recomposed.shelves.find((shelf) => shelf.id === 'for-you')
    const nextAlbumIds = (nextForYou?.items ?? [])
      .filter((item): item is DiscoverAlbumItem => item.grain === 'album')
      .map((item) => item.albumId)
    const savedAlbumIds = forYou!.items
      .filter((item): item is DiscoverAlbumItem => item.grain === 'album')
      .map((item) => item.albumId)
    expect(nextAlbumIds).not.toEqual(savedAlbumIds)

    // The engine still holds the first result until `shelves` is asked again.
    expect(snapshotShelf(engine.lastResult(), 'for-you').items).toBe(forYou!.items)
    expect(playlistTrackIds(playlists, playlist.id)).toEqual(savedIds)

    addListen(opened.db, savedIds[0]!, NOW)
    rebuild(opened.db)
    engine.shelves(NOW)
    expect(playlistTrackIds(playlists, playlist.id)).toEqual(savedIds)
  })
})
