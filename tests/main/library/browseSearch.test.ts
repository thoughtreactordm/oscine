import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { SqliteLibraryService } from '../../../src/main/library/sqliteService'

let dir: string
let opened: OpenDatabaseResult
let service: SqliteLibraryService
let ids: {
  rootOne: number
  rootTwo: number
  queen: number
  sigur: number
  other: number
  opera: number
  emptyAlbum: number
  covers: number
  bohemian: number
  samskeyti: number
}

function insertId(result: { lastInsertRowid: number | bigint }): number {
  return Number(result.lastInsertRowid)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-browse-'))
  opened = openDatabase(join(dir, 'library.db'))
  const { db } = opened

  const root = db.prepare('INSERT INTO roots(label, path, added_at) VALUES (?, ?, ?)')
  const artist = db.prepare('INSERT INTO artists(name) VALUES (?)')
  const album = db.prepare('INSERT INTO albums(title, album_artist_id, year) VALUES (?, ?, ?)')
  const track = db.prepare(
    `INSERT INTO tracks(
       root_id, rel_path, mtime, size, title, artist_id, album_id, track_no, disc_no
     ) VALUES (?, ?, 1, 100, ?, ?, ?, ?, 1)`
  )

  const rootOne = insertId(root.run('Main', '/music/main', 1))
  const rootTwo = insertId(root.run('Second', '/music/second', 2))
  const queen = insertId(artist.run('Queen'))
  const sigur = insertId(artist.run('Sigur Rós'))
  const other = insertId(artist.run('Other Artist'))
  const opera = insertId(album.run('A Night at the Opera', queen, 1975))
  const emptyAlbum = insertId(album.run('( )', sigur, 2002))
  const covers = insertId(album.run('Covers', other, 2020))

  const bohemian = insertId(
    track.run(rootOne, 'queen/bohemian.flac', 'Bohemian Rhapsody', queen, opera, 11)
  )
  track.run(rootOne, 'queen/love.flac', 'Love of My Life', queen, opera, 9)
  const samskeyti = insertId(
    track.run(rootOne, 'sigur/samskeyti.flac', 'Samskeyti 東京音楽', sigur, emptyAlbum, 3)
  )
  track.run(rootTwo, 'covers/bohemian.flac', 'Bohemian Reprise', other, covers, 1)

  ids = {
    rootOne,
    rootTwo,
    queen,
    sigur,
    other,
    opera,
    emptyAlbum,
    covers,
    bohemian,
    samskeyti
  }
  service = new SqliteLibraryService({
    db,
    pickFolder: async () => null,
    onProgress: () => {}
  })
})

afterEach(async () => {
  await service.close()
  opened.db.close()
  rmSync(dir, { recursive: true, force: true })
})

const window = {
  sort: 'title' as const,
  direction: 'asc' as const,
  offset: 0,
  limit: 100
}

describe('library browse and infix search', () => {
  it('finds literal infixes across title, artist and album with Unicode folding', async () => {
    const title = await service.listTracks({ ...window, searchText: 'hemian' })
    expect(title.tracks.map((track) => track.title)).toEqual([
      'Bohemian Reprise',
      'Bohemian Rhapsody'
    ])

    const artist = await service.listTracks({ ...window, searchText: 'ros' })
    expect(artist.tracks.map((track) => track.id)).toEqual([ids.samskeyti])

    const unicode = await service.listTracks({ ...window, searchText: '東京音' })
    expect(unicode.tracks.map((track) => track.id)).toEqual([ids.samskeyti])

    const acrossFields = await service.listTracks({
      ...window,
      searchText: 'Queen Opera'
    })
    expect(acrossFields.tracks.map((track) => track.id)).toEqual([ids.bohemian, ids.bohemian + 1])

    const shortStopWord = await service.listTracks({
      ...window,
      searchText: 'A Night'
    })
    expect(shortStopWord.tracks.map((track) => track.id)).toEqual([ids.bohemian, ids.bohemian + 1])
  })

  it('composes root, artist, album, search, sort and windowing', async () => {
    const result = await service.listTracks({
      ...window,
      rootId: ids.rootOne,
      artistIds: [ids.queen],
      albumIds: [ids.opera],
      searchText: 'hemian',
      offset: 0,
      limit: 1
    })

    expect(result.total).toBe(1)
    expect(result.tracks).toHaveLength(1)
    expect(result.tracks[0]).toMatchObject({
      id: ids.bohemian,
      rootId: ids.rootOne,
      artist: 'Queen',
      album: 'A Night at the Opera'
    })
  })

  it('composes the full filter set with every declared sort and direction', async () => {
    for (const sort of ['trackNo', 'title', 'artist', 'album', 'durationSec'] as const) {
      for (const direction of ['asc', 'desc'] as const) {
        const result = await service.listTracks({
          rootId: ids.rootOne,
          artistIds: [ids.queen],
          albumIds: [ids.opera],
          searchText: 'Opera',
          sort,
          direction,
          offset: 0,
          limit: 100
        })
        expect(result.total).toBe(2)
        expect(result.tracks.map((track) => track.id).sort((a, b) => a - b)).toEqual([
          ids.bohemian,
          ids.bohemian + 1
        ])
      }
    }
  })

  it('keeps the existing all-tracks behavior when every optional filter is empty', async () => {
    const result = await service.listTracks(window)
    expect(result.total).toBe(4)
    expect(result.tracks).toHaveLength(4)
  })

  it('pages artist and album facets with counts and stable filtering', async () => {
    const artists = await service.listArtists({
      rootId: ids.rootOne,
      offset: 0,
      limit: 1
    })
    expect(artists.total).toBe(2)
    expect(artists.artists).toEqual([{ id: ids.queen, name: 'Queen', trackCount: 2 }])

    const albums = await service.listAlbums({
      rootId: ids.rootOne,
      artistIds: [ids.queen],
      offset: 0,
      limit: 100
    })
    expect(albums).toEqual({
      total: 1,
      albums: [
        {
          id: ids.opera,
          title: 'A Night at the Opera',
          albumArtist: 'Queen',
          year: 1975,
          trackCount: 2,
          artwork: {
            small: 'fermata://artwork/missing/small',
            large: 'fermata://artwork/missing/large'
          }
        }
      ]
    })

    const searched = await service.listArtists({
      searchText: 'hemian',
      offset: 0,
      limit: 100
    })
    expect(searched.artists.map((artist) => artist.id)).toEqual([ids.other, ids.queen])
  })

  it('groups featured performers under the album artist', async () => {
    const featuredArtist = insertId(
      opened.db.prepare('INSERT INTO artists(name) VALUES (?)').run('Queen feat. David Bowie')
    )
    opened.db
      .prepare(
        `INSERT INTO tracks(
           root_id, rel_path, mtime, size, title, artist_id, album_id, track_no, disc_no
         ) VALUES (?, ?, 1, 100, ?, ?, ?, ?, 1)`
      )
      .run(ids.rootOne, 'queen/pressure.flac', 'Under Pressure', featuredArtist, ids.opera, 3)

    const artists = await service.listArtists({ offset: 0, limit: 100 })
    expect(artists.artists).toEqual([
      { id: ids.other, name: 'Other Artist', trackCount: 1 },
      { id: ids.queen, name: 'Queen', trackCount: 3 },
      { id: ids.sigur, name: 'Sigur Rós', trackCount: 1 }
    ])

    const queenTracks = await service.listTracks({
      ...window,
      artistIds: [ids.queen]
    })
    expect(queenTracks.tracks.map((track) => track.title)).toEqual([
      'Bohemian Rhapsody',
      'Love of My Life',
      'Under Pressure'
    ])
    expect(queenTracks.tracks.at(-1)?.artist).toBe('Queen feat. David Bowie')
  })

  it('updates and deletes FTS rows in the same transaction as track metadata', async () => {
    opened.db
      .prepare('UPDATE tracks SET title = ?, artist_id = ?, album_id = ? WHERE id = ?')
      .run('Paranoid Android', ids.other, ids.covers, ids.bohemian)

    expect((await service.listTracks({ ...window, searchText: 'hemian' })).total).toBe(1)
    expect((await service.listTracks({ ...window, searchText: 'anoid' })).tracks[0]).toMatchObject({
      id: ids.bohemian,
      artist: 'Other Artist',
      album: 'Covers'
    })

    opened.db.prepare('DELETE FROM tracks WHERE id = ?').run(ids.bohemian)
    expect((await service.listTracks({ ...window, searchText: 'anoid' })).total).toBe(0)

    opened.db.prepare('DELETE FROM roots WHERE id = ?').run(ids.rootTwo)
    expect((await service.listTracks({ ...window, searchText: 'hemian' })).total).toBe(0)
  })

  it('treats quotes and FTS operators as literal search text', async () => {
    const result = await service.listTracks({
      ...window,
      searchText: 'hemian" OR artist:Queen'
    })
    expect(result).toEqual({ tracks: [], total: 0 })
  })
})

describe('facet id sets as a browse filter', () => {
  it('unions within a dimension and intersects across them', async () => {
    const union = await service.listTracks({
      ...window,
      artistIds: [ids.queen, ids.sigur]
    })
    expect(union.tracks.map((track) => track.title)).toEqual([
      'Bohemian Rhapsody',
      'Love of My Life',
      'Samskeyti 東京音楽'
    ])
    // The fourth track in the fixture belongs to neither artist and stays out.
    expect(union.total).toBe(3)

    // The dimensions AND: two artists and one of their albums is that album, not
    // everything either of them recorded.
    const narrowed = await service.listTracks({
      ...window,
      artistIds: [ids.queen, ids.sigur],
      albumIds: [ids.emptyAlbum]
    })
    expect(narrowed.tracks.map((track) => track.title)).toEqual(['Samskeyti 東京音楽'])
  })

  it('reads a repeated id the same way as a single one', async () => {
    // The store spells one id as an equality and several as a `json_each` join.
    // Two SQL paths for one predicate is exactly the sort of thing that agrees
    // until it does not.
    const single = await service.listTracks({ ...window, artistIds: [ids.queen] })
    const repeated = await service.listTracks({ ...window, artistIds: [ids.queen, ids.queen] })
    expect(repeated).toEqual(single)
  })

  it('resolves facet ids in the same order as the facet rows', async () => {
    const rows = await service.listAlbums({ rootId: ids.rootOne, offset: 0, limit: 100 })
    const resolved = await service.listAlbumIds({ rootId: ids.rootOne, offset: 0, limit: 100 })

    // The contract a Shift-range depends on: the id at a position is the id of
    // the row the user would have seen there.
    expect(resolved.ids).toEqual(rows.albums.map((album) => album.id))
    expect(resolved.total).toBe(rows.total)

    const artistRows = await service.listArtists({ offset: 0, limit: 100 })
    const artistIds = await service.listArtistIds({ offset: 0, limit: 100 })
    expect(artistIds.ids).toEqual(artistRows.artists.map((artist) => artist.id))
    expect(artistIds.total).toBe(artistRows.total)
  })

  it('answers a window into the middle of a facet', async () => {
    const all = await service.listArtistIds({ offset: 0, limit: 100 })
    const slice = await service.listArtistIds({ offset: 1, limit: 2 })

    expect(slice.ids).toEqual(all.ids.slice(1, 3))
    // The total ignores the window, so a pane can size its scrollbar from any page.
    expect(slice.total).toBe(all.total)
  })

  it('prunes a selection by filtering it with itself', async () => {
    // What the renderer asks when the artist selection narrows under an album
    // selection: of these three albums, which survive the new predicate?
    const surviving = await service.listAlbumIds({
      artistIds: [ids.queen],
      albumIds: [ids.opera, ids.emptyAlbum, ids.covers],
      offset: 0,
      limit: 100
    })
    expect(surviving.ids).toEqual([ids.opera])
  })
})
