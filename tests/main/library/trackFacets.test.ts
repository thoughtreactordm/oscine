import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { SqliteLibraryService } from '../../../src/main/library/sqliteService'

/**
 * `trackFacets` and the round trip it exists for — **W15-3**.
 *
 * The Tags pane's batch options resolve to `listTrackIds({ albumIds })` and
 * `listTrackIds({ artistIds })`, so the two ids this returns have to be in the
 * *browse* dimension's space, not the bare columns'. The compilation case is the
 * whole reason: a track whose own performer is not the album artist must resolve
 * to the album artist, because that is what the Artist facet filters on — get it
 * wrong and "everything by this artist" would exclude the very track it was asked
 * from.
 */
describe('trackFacets', () => {
  let dir: string
  let opened: OpenDatabaseResult
  let service: SqliteLibraryService

  let soloArtist: number
  let compilationArtist: number
  let performer: number
  let soloAlbum: number
  let compilationAlbum: number

  let soloTrack: number
  let compilationTrack: number
  let looseTrack: number
  let untaggedTrack: number

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-track-facets-'))
    opened = openDatabase(join(dir, 'library.db'))
    const { db } = opened

    const rootId = Number(
      db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run('Synthetic', '/synthetic', 1).lastInsertRowid
    )
    const insertArtist = db.prepare('INSERT INTO artists (name) VALUES (?)')
    soloArtist = Number(insertArtist.run('Solo').lastInsertRowid)
    compilationArtist = Number(insertArtist.run('Various Artists').lastInsertRowid)
    performer = Number(insertArtist.run('Guest Performer').lastInsertRowid)

    const insertAlbum = db.prepare(
      'INSERT INTO albums (title, album_artist_id, year) VALUES (?, ?, ?)'
    )
    soloAlbum = Number(insertAlbum.run('Solo Album', soloArtist, 2001).lastInsertRowid)
    compilationAlbum = Number(
      insertAlbum.run('A Compilation', compilationArtist, 2002).lastInsertRowid
    )

    const insertTrack = db.prepare(
      `INSERT INTO tracks (root_id, rel_path, mtime, size, title, artist_id, album_id, track_no)
       VALUES (?, ?, 1, 1, ?, ?, ?, ?)`
    )
    // A track on its own artist's album — performer and album artist coincide.
    soloTrack = Number(
      insertTrack.run(rootId, 'solo.flac', 'Solo Song', soloArtist, soloAlbum, 1).lastInsertRowid
    )
    // The compilation case: the performer is not the album artist.
    compilationTrack = Number(
      insertTrack.run(rootId, 'comp.flac', 'Comp Song', performer, compilationAlbum, 1)
        .lastInsertRowid
    )
    // A loose track with a performer but no album — album artist is absent, so
    // the browse artist falls back to the performer.
    looseTrack = Number(
      insertTrack.run(rootId, 'loose.flac', 'Loose Song', soloArtist, null, null).lastInsertRowid
    )
    // Named neither.
    untaggedTrack = Number(
      insertTrack.run(rootId, 'untagged.flac', 'Untagged', null, null, null).lastInsertRowid
    )

    service = new SqliteLibraryService({
      db,
      pickFolder: async () => null,
      onProgress: () => {}
    })
  })

  afterAll(async () => {
    await service?.close()
    opened?.db.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('resolves an ordinary track to its album and its album artist', async () => {
    expect(await service.trackFacets(soloTrack)).toEqual({
      albumId: soloAlbum,
      artistId: soloArtist
    })
  })

  it('resolves a compilation track to the album artist, not the performer', async () => {
    expect(await service.trackFacets(compilationTrack)).toEqual({
      albumId: compilationAlbum,
      artistId: compilationArtist
    })
  })

  it('falls back to the performer for a loose track with no album', async () => {
    expect(await service.trackFacets(looseTrack)).toEqual({
      albumId: null,
      artistId: soloArtist
    })
  })

  it('answers two nulls for a track that names neither', async () => {
    expect(await service.trackFacets(untaggedTrack)).toEqual({ albumId: null, artistId: null })
  })

  it('answers two nulls for a track that has left the library', async () => {
    expect(await service.trackFacets(999_999)).toEqual({ albumId: null, artistId: null })
  })

  it('returns ids that drive listTrackIds back to the same track', async () => {
    const { albumId, artistId } = await service.trackFacets(compilationTrack)
    expect(albumId).not.toBeNull()
    expect(artistId).not.toBeNull()

    const byAlbum = await service.listTrackIds({
      albumIds: [albumId as number],
      sort: 'trackNo',
      direction: 'asc',
      offset: 0,
      limit: 100
    })
    const byArtist = await service.listTrackIds({
      artistIds: [artistId as number],
      sort: 'artist',
      direction: 'asc',
      offset: 0,
      limit: 100
    })

    // The seed is in both sets — the property "everything by this artist"
    // depends on, and the reason the artist id is the browse one.
    expect(byAlbum.ids).toContain(compilationTrack)
    expect(byArtist.ids).toContain(compilationTrack)
  })
})
