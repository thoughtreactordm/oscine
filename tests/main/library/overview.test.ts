import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { LibraryStore } from '../../../src/main/library/store'

/**
 * `libraryOverview` — **W24-1**, the read behind `library_overview`. Coverage is
 * of the *effective* value, so the album-artist, genre and artwork overrides
 * must each move a count the way the editor would show it.
 */
describe('libraryOverview', () => {
  let dir: string
  let opened: OpenDatabaseResult
  let store: LibraryStore

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-overview-'))
    opened = openDatabase(join(dir, 'library.db'))
    const { db } = opened
    store = new LibraryStore(db)

    const root = (label: string, path: string): number =>
      Number(
        db.prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, 1)').run(label, path)
          .lastInsertRowid
      )
    const music = root('Music', '/abs/music')
    root('Empty', '/abs/empty')

    const artist = (name: string): number =>
      Number(db.prepare('INSERT INTO artists (name) VALUES (?)').run(name).lastInsertRowid)
    const solo = artist('Solo')
    const guest = artist('Guest')
    artist('Orphan') // referenced by nothing, so not counted

    const album = Number(
      db
        .prepare(
          'INSERT INTO albums (title, album_artist_id, year, artwork_hash) VALUES (?, ?, ?, ?)'
        )
        .run('Record', solo, 2001, 'abc').lastInsertRowid
    )

    const insert = db.prepare(
      `INSERT INTO tracks (root_id, rel_path, mtime, size, duration_ms, codec, title, artist_id,
                           album_id, track_no, genre, rg_track_gain)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    const a = Number(
      insert.run(music, 'a.flac', 100, 1000, 'flac', 'A', solo, album, 1, 'Jazz', -6)
        .lastInsertRowid
    )
    const b = Number(
      insert.run(music, 'b.flac', 200, 2000, 'flac', 'B', guest, album, 2, null, null)
        .lastInsertRowid
    )
    const c = Number(
      insert.run(music, 'c.mp3', 300, 3000, 'mp3', '  ', null, null, null, null, null)
        .lastInsertRowid
    )

    // Genre set by correction on b; a's artwork cleared by override; c gets a user tag.
    db.prepare('INSERT INTO track_overrides (track_id, genre, updated_at) VALUES (?, ?, 1)').run(
      b,
      'Funk'
    )
    db.prepare(
      'INSERT INTO artwork_overrides (track_id, image_hash, mime, created_at) VALUES (?, NULL, NULL, 1)'
    ).run(a)
    const tag = Number(
      db.prepare("INSERT INTO tags (key, label, created_at) VALUES ('live', 'Live', 1)").run()
        .lastInsertRowid
    )
    db.prepare(
      "INSERT INTO track_tags (track_id, tag_id, source, created_at) VALUES (?, ?, 'user', 1)"
    ).run(c, tag)
    db.prepare(
      "INSERT INTO track_tag_overrides (track_id, field, value, updated_at) VALUES (?, 'bpm', '120', 1)"
    ).run(c)
  })

  afterAll(() => {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('counts tracks, albums and only the artists something references', () => {
    const overview = store.libraryOverview()
    expect(overview).toMatchObject({
      tracks: 3,
      albums: 1,
      artists: 2,
      totalDurationMs: 6000,
      totalBytes: 600
    })
  })

  it('reports formats most-used first and roots by label, never by path', () => {
    const overview = store.libraryOverview()
    expect(overview.formats).toEqual([
      { codec: 'flac', tracks: 2 },
      { codec: 'mp3', tracks: 1 }
    ])
    expect(overview.roots).toEqual([
      { id: 1, name: 'Music', tracks: 3 },
      { id: 2, name: 'Empty', tracks: 0 }
    ])
    expect(JSON.stringify(overview)).not.toContain('/abs/')
  })

  it('counts coverage of the effective value, overrides applied', () => {
    expect(store.libraryOverview().coverage).toEqual({
      title: 2, // a blank title is not coverage
      artist: 2,
      album: 2,
      albumArtist: 2,
      trackNo: 2,
      discNo: 0,
      year: 2,
      genre: 2, // a's own tag plus b's correction
      artwork: 1, // a's cleared by override, b's from the album
      replayGainTrack: 1,
      replayGainAlbum: 0,
      userTags: 1
    })
    expect(store.libraryOverview().tracksWithCorrections).toBe(3)
  })
})
