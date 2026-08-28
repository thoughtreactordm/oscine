import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { LibraryStore } from '../../../src/main/library/store'
import type { TrackTags } from '../../../src/main/library/metadata'

/**
 * The metadata editor's write path — **W16 (editor)**.
 *
 * The property that matters: an edit is *materialised* into the live rows, so a
 * corrected title/artist/album shows in `listTracks` and — the whole point of
 * "full re-facet" — a corrected artist moves the track under the right facet at
 * once, without a re-scan. And it round-trips: reverting to the file's tags puts
 * everything back and drops the override row.
 */

const NOW = 1_000

function fileTags(over: Partial<TrackTags>): TrackTags {
  return {
    title: null,
    artist: null,
    album: null,
    albumArtist: null,
    trackNo: null,
    discNo: null,
    year: null,
    durationMs: null,
    codec: null,
    sampleRate: null,
    channels: null,
    bitDepth: null,
    genre: null,
    replayGain: null,
    ...over
  }
}

describe('track overrides', () => {
  let dir: string
  let opened: OpenDatabaseResult
  let store: LibraryStore
  let rootId: number

  function insertArtist(name: string): number {
    return Number(
      opened.db.prepare('INSERT INTO artists (name) VALUES (?)').run(name).lastInsertRowid
    )
  }
  function insertAlbum(title: string, albumArtistId: number | null, year: number | null): number {
    return Number(
      opened.db
        .prepare('INSERT INTO albums (title, album_artist_id, year) VALUES (?, ?, ?)')
        .run(title, albumArtistId, year).lastInsertRowid
    )
  }
  function insertTrack(rel: string, cols: Record<string, unknown>): number {
    return Number(
      opened.db
        .prepare(
          `INSERT INTO tracks (root_id, rel_path, mtime, size, title, artist_id, album_id, track_no, disc_no, genre)
           VALUES (@rootId, @rel, 1, 1, @title, @artistId, @albumId, @trackNo, @discNo, @genre)`
        )
        .run({
          rootId,
          rel,
          title: null,
          artistId: null,
          albumId: null,
          trackNo: null,
          discNo: null,
          genre: null,
          ...cols
        }).lastInsertRowid
    )
  }

  function trackById(id: number) {
    return store.getTracksByIds({ ids: [id] })[0]
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oscine-overrides-'))
    opened = openDatabase(join(dir, 'library.db'))
    store = new LibraryStore(opened.db)
    rootId = Number(
      opened.db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run('Synthetic', '/synthetic', 1).lastInsertRowid
    )
  })

  afterEach(() => {
    opened.db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('materialises scalar edits into the display row', () => {
    const artist = insertArtist('Old Artist')
    const track = insertTrack('a.flac', { title: 'Old', artistId: artist, trackNo: 1 })

    store.setOverrides([track], { title: 'New Title', trackNo: 7 }, NOW)

    const row = trackById(track)
    expect(row.title).toBe('New Title')
    expect(row.trackNo).toBe(7)
  })

  it('re-facets a loose track under a corrected artist', () => {
    const artist = insertArtist('Old Artist')
    const track = insertTrack('a.flac', { title: 'Song', artistId: artist })

    store.setOverrides([track], { artist: 'Corrected Artist' }, NOW)

    const artists = store.listArtists({ offset: 0, limit: 100 }).artists
    const names = artists.map((a) => a.name)
    expect(names).toContain('Corrected Artist')
    expect(names).not.toContain('Old Artist')
    expect(trackById(track).artist).toBe('Corrected Artist')
  })

  it('re-facets a track under a corrected album', () => {
    const artist = insertArtist('Artist')
    const album = insertAlbum('Old Album', artist, 2001)
    const track = insertTrack('a.flac', { title: 'Song', artistId: artist, albumId: album })

    store.setOverrides([track], { album: 'New Album', year: 2020 }, NOW)

    const albums = store.listAlbums({ offset: 0, limit: 100 }).albums
    const titles = albums.map((a) => a.title)
    expect(titles).toContain('New Album')
    expect(titles).not.toContain('Old Album')
    const row = trackById(track)
    expect(row.album).toBe('New Album')
    expect(row.year).toBe(2020)
  })

  it('folds a batch into a shared value or mixed, and marks overrides', () => {
    const artist = insertArtist('Artist')
    const t1 = insertTrack('a.flac', { title: 'One', artistId: artist })
    const t2 = insertTrack('b.flac', { title: 'Two', artistId: artist })

    const before = store.overrideEditState([t1, t2])
    expect(before.title.mixed).toBe(true)
    expect(before.artist.value).toBe('Artist')
    expect(before.artist.overridden).toBe(false)

    store.setOverrides([t1, t2], { artist: 'Both' }, NOW)

    const after = store.overrideEditState([t1, t2])
    expect(after.artist.value).toBe('Both')
    expect(after.artist.overridden).toBe(true)
  })

  it('reverts fields to the file’s tags and drops an emptied override row', () => {
    const artist = insertArtist('Old Artist')
    const track = insertTrack('a.flac', { title: 'Old', artistId: artist, trackNo: 1 })

    store.setOverrides([track], { title: 'New', artist: 'New Artist' }, NOW)
    expect(trackById(track).title).toBe('New')

    store.revertOverrides(
      [{ trackId: track, file: fileTags({ title: 'Old', artist: 'Old Artist', trackNo: 1 }) }],
      ['title', 'artist'],
      NOW
    )

    const row = trackById(track)
    expect(row.title).toBe('Old')
    expect(row.artist).toBe('Old Artist')

    const overrideRow = opened.db
      .prepare('SELECT COUNT(*) AS n FROM track_overrides WHERE track_id = ?')
      .get(track) as { n: number }
    expect(overrideRow.n).toBe(0)
  })

  it('marks a track modified and lists it pending until its write is retired', () => {
    const artist = insertArtist('A')
    const track = insertTrack('a.flac', { title: 'Old', artistId: artist })
    expect(trackById(track).modified).toBe(false)

    store.setOverrides([track], { title: 'New' }, NOW)
    expect(trackById(track).modified).toBe(true)
    expect(store.pendingWritebackTrackIds()).toContain(track)

    store.retireWrittenOverrides(track, ['title'], NOW)
    expect(trackById(track).modified).toBe(false)
    expect(store.pendingWritebackTrackIds()).not.toContain(track)
    // The materialised value stays — the file now holds it.
    expect(trackById(track).title).toBe('New')
  })

  it('keeps un-written fields pending when only some are retired', () => {
    const artist = insertArtist('A')
    const track = insertTrack('a.flac', { title: 'Old', artistId: artist, trackNo: 1 })
    store.setOverrides([track], { title: 'New', trackNo: 5 }, NOW)

    // A partial flush wrote only the title.
    store.retireWrittenOverrides(track, ['title'], NOW)

    expect(trackById(track).modified).toBe(true)
    expect(store.pendingWritebackTrackIds()).toContain(track)
  })

  it('records a genre override as the effective genre without a re-scan', () => {
    const track = insertTrack('a.flac', { title: 'Song', genre: 'Rock' })

    store.setOverrides([track], { genre: 'Jazz; Fusion' }, NOW)

    expect(store.overrideEditState([track]).genre).toMatchObject({
      value: 'Jazz; Fusion',
      overridden: true
    })
  })
})
