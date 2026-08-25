import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { LibraryStore } from '../../../src/main/library/store'

/**
 * Removing a library folder.
 *
 * The cascades are SQLite's and are not worth testing — `ON DELETE CASCADE` is
 * declared in schema v1 and works. What is worth testing is everything the
 * cascades *do not* reach: `albums` and `artists` are keyed by name rather than
 * by root, so nothing in the foreign-key graph removes the ones a departing
 * root was the last to need. They are invisible to the browser either way,
 * because every facet query is over `tracks` — which is exactly why a bug here
 * would go unnoticed until a database someone had been using for a year was
 * mostly rows for music they had removed.
 *
 * The other half is the shared case: an artist two roots both have must survive
 * one of them leaving. That is the test that fails if the prune is written as
 * "delete what this root referenced" instead of "delete what nothing references".
 */
describe('LibraryStore.removeRoot', () => {
  let dir: string
  let opened: OpenDatabaseResult
  let store: LibraryStore

  let keptRootId: number
  let doomedRootId: number
  let sharedArtistId: number
  let soloArtistId: number
  let sharedAlbumId: number
  let soloAlbumId: number
  let doomedTrackId: number
  let keptTrackId: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-remove-root-'))
    opened = openDatabase(join(dir, 'library.db'))
    const { db } = opened

    const insertRoot = db.prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
    keptRootId = Number(insertRoot.run('Kept', '/kept', 1).lastInsertRowid)
    doomedRootId = Number(insertRoot.run('Doomed', '/doomed', 1).lastInsertRowid)

    const insertArtist = db.prepare('INSERT INTO artists (name) VALUES (?)')
    // On both roots. Must survive.
    sharedArtistId = Number(insertArtist.run('Shared Artist').lastInsertRowid)
    // Only on the doomed root. Must go.
    soloArtistId = Number(insertArtist.run('Solo Artist').lastInsertRowid)

    const insertAlbum = db.prepare(
      'INSERT INTO albums (title, album_artist_id, year) VALUES (?, ?, ?)'
    )
    sharedAlbumId = Number(insertAlbum.run('Shared Album', sharedArtistId, 1999).lastInsertRowid)
    soloAlbumId = Number(insertAlbum.run('Solo Album', soloArtistId, 2001).lastInsertRowid)

    const insertTrack = db.prepare(`
      INSERT INTO tracks (root_id, rel_path, mtime, size, title, artist_id, album_id)
      VALUES (?, ?, 1, 1, ?, ?, ?)
    `)
    keptTrackId = Number(
      insertTrack.run(keptRootId, 'a/b/keep.flac', 'Keep', sharedArtistId, sharedAlbumId)
        .lastInsertRowid
    )
    doomedTrackId = Number(
      insertTrack.run(doomedRootId, 'a/b/go.flac', 'Go', soloArtistId, soloAlbumId).lastInsertRowid
    )
    // Also on the doomed root, but crediting the shared album — so the shared
    // album loses a track without losing all of them.
    insertTrack.run(doomedRootId, 'a/b/go2.flac', 'Go Too', sharedArtistId, sharedAlbumId)

    store = new LibraryStore(db)
  })

  afterEach(() => {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const count = (sql: string, ...params: unknown[]): number =>
    (opened.db.prepare(sql).get(...params) as { c: number }).c

  it('removes the root row', () => {
    expect(store.removeRoot(doomedRootId)).toBe(true)
    expect(count('SELECT COUNT(*) c FROM roots WHERE id = ?', doomedRootId)).toBe(0)
    expect(count('SELECT COUNT(*) c FROM roots WHERE id = ?', keptRootId)).toBe(1)
  })

  it("takes the root's tracks with it and leaves the other root's alone", () => {
    store.removeRoot(doomedRootId)
    expect(count('SELECT COUNT(*) c FROM tracks WHERE root_id = ?', doomedRootId)).toBe(0)
    expect(count('SELECT COUNT(*) c FROM tracks WHERE id = ?', keptTrackId)).toBe(1)
  })

  it('prunes an album nothing references any more', () => {
    store.removeRoot(doomedRootId)
    expect(count('SELECT COUNT(*) c FROM albums WHERE id = ?', soloAlbumId)).toBe(0)
  })

  it('keeps an album another root still has tracks on', () => {
    // The shared album lost one of its two tracks. Losing a track is not the
    // same as being empty, and a prune that confused the two would delete an
    // album the kept root is still showing.
    store.removeRoot(doomedRootId)
    expect(count('SELECT COUNT(*) c FROM albums WHERE id = ?', sharedAlbumId)).toBe(1)
  })

  it('prunes an artist nothing references any more', () => {
    store.removeRoot(doomedRootId)
    expect(count('SELECT COUNT(*) c FROM artists WHERE id = ?', soloArtistId)).toBe(0)
  })

  it('keeps an artist another root still has tracks by', () => {
    store.removeRoot(doomedRootId)
    expect(count('SELECT COUNT(*) c FROM artists WHERE id = ?', sharedArtistId)).toBe(1)
  })

  it('keeps an artist held alive only by an album credit', () => {
    // No tracks of their own anywhere, but they are an album artist. Deleting
    // them would leave `albums.album_artist_id` pointing at nothing and the
    // album would show as having no artist.
    const { db } = opened
    const creditOnly = Number(
      db.prepare('INSERT INTO artists (name) VALUES (?)').run('Credit Only').lastInsertRowid
    )
    db.prepare('UPDATE albums SET album_artist_id = ? WHERE id = ?').run(creditOnly, sharedAlbumId)

    store.removeRoot(doomedRootId)
    expect(count('SELECT COUNT(*) c FROM artists WHERE id = ?', creditOnly)).toBe(1)
  })

  it('takes play history for the removed tracks', () => {
    const { db } = opened
    db.prepare('INSERT INTO play_history (track_id, played_at) VALUES (?, ?)').run(doomedTrackId, 1)
    db.prepare('INSERT INTO play_history (track_id, played_at) VALUES (?, ?)').run(keptTrackId, 2)

    store.removeRoot(doomedRootId)
    expect(count('SELECT COUNT(*) c FROM play_history WHERE track_id = ?', doomedTrackId)).toBe(0)
    expect(count('SELECT COUNT(*) c FROM play_history WHERE track_id = ?', keptTrackId)).toBe(1)
  })

  it('takes playlist entries for the removed tracks and leaves the playlist', () => {
    // The behaviour the confirmation dialog promises. The playlist survives
    // with fewer entries; it is not deleted along with the folder.
    const { db } = opened
    const playlistId = Number(
      db
        .prepare(
          'INSERT INTO playlists (name, position, created_at, updated_at) VALUES (?, 0, 1, 1)'
        )
        .run('Mix').lastInsertRowid
    )
    const addEntry = db.prepare(
      'INSERT INTO playlist_entries (playlist_id, track_id, position) VALUES (?, ?, ?)'
    )
    addEntry.run(playlistId, doomedTrackId, 1)
    addEntry.run(playlistId, keptTrackId, 2)

    store.removeRoot(doomedRootId)
    expect(count('SELECT COUNT(*) c FROM playlists WHERE id = ?', playlistId)).toBe(1)
    expect(count('SELECT COUNT(*) c FROM playlist_entries WHERE playlist_id = ?', playlistId)).toBe(
      1
    )
  })

  it('also sweeps orphans that were already there', () => {
    // The prune is "delete what nothing references" rather than "delete what
    // this root referenced", because the second is wrong for a shared artist.
    // The consequence is this, and it is intended: a removal collects any
    // orphan already lying about. Pinned so that turning the prune into a
    // scoped one — which would reintroduce the shared-artist bug — fails here
    // as well as in the test above.
    const { db } = opened
    const strayArtist = Number(
      db.prepare('INSERT INTO artists (name) VALUES (?)').run('Stray').lastInsertRowid
    )
    const strayAlbum = Number(
      db
        .prepare('INSERT INTO albums (title, album_artist_id, year) VALUES (?, ?, ?)')
        .run('Stray Album', null, 1990).lastInsertRowid
    )

    store.removeRoot(doomedRootId)
    expect(count('SELECT COUNT(*) c FROM artists WHERE id = ?', strayArtist)).toBe(0)
    expect(count('SELECT COUNT(*) c FROM albums WHERE id = ?', strayAlbum)).toBe(0)
  })

  it('reports a root that was already gone rather than throwing', () => {
    // Two windows, or a double-click. The second caller wants the end state the
    // first one produced, not an error about it.
    expect(store.removeRoot(doomedRootId)).toBe(true)
    expect(store.removeRoot(doomedRootId)).toBe(false)
  })

  it('leaves an unrelated root entirely intact', () => {
    store.removeRoot(doomedRootId)
    expect(count('SELECT COUNT(*) c FROM tracks')).toBe(1)
    expect(count('SELECT COUNT(*) c FROM albums')).toBe(1)
    expect(count('SELECT COUNT(*) c FROM artists')).toBe(1)
  })
})
