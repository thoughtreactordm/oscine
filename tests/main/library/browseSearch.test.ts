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
      artistId: ids.queen,
      albumId: ids.opera,
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
          artistId: ids.queen,
          albumId: ids.opera,
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
      artistId: ids.queen,
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
      artistId: ids.queen
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
