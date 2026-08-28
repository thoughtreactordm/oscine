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

  /**
   * Re-scan reconciliation — **W16-7**, design authority D28.
   *
   * The counterpart to the flush-driven retire above: an override retires once a
   * re-scan reads the correction back off the file, by whatever route it got
   * there — a flush, or an out-of-band edit by another tagger. Driven through the
   * real scan upsert (`writeTracks`) so the retire fires exactly where a live
   * re-scan would.
   */
  describe('re-scan reconciliation', () => {
    function rescan(rel: string, over: Partial<TrackTags>): number {
      store.writeTracks(
        rootId,
        [
          {
            file: { absPath: `/synthetic/${rel}`, relPath: rel, mtime: 1, size: 1 },
            tags: fileTags(over)
          }
        ],
        NOW
      )
      return (
        opened.db.prepare('SELECT id FROM tracks WHERE rel_path = ?').get(rel) as { id: number }
      ).id
    }

    function overrideCount(track: number): number {
      return (
        opened.db
          .prepare('SELECT COUNT(*) AS n FROM track_overrides WHERE track_id = ?')
          .get(track) as { n: number }
      ).n
    }

    it('retires an override the re-scan finds the file already holds', () => {
      const track = rescan('a.flac', { title: 'Old' })
      store.setOverrides([track], { title: 'New' }, NOW)
      expect(trackById(track).modified).toBe(true)

      // Another tagger wrote the correction to the file; the re-scan reads it back.
      rescan('a.flac', { title: 'New' })

      expect(overrideCount(track)).toBe(0)
      expect(trackById(track).modified).toBe(false)
      expect(store.pendingWritebackTrackIds()).not.toContain(track)
      // The library reads the correction from the file alone.
      expect(trackById(track).title).toBe('New')
    })

    it('keeps an override the re-scanned file still contradicts', () => {
      const track = rescan('a.flac', { title: 'Old' })
      store.setOverrides([track], { title: 'New' }, NOW)

      // The file is unchanged: the correction is still unwritten.
      rescan('a.flac', { title: 'Old' })

      expect(overrideCount(track)).toBe(1)
      expect(trackById(track).modified).toBe(true)
      expect(store.pendingWritebackTrackIds()).toContain(track)
      // The override still stands over the file's stale value.
      expect(trackById(track).title).toBe('New')
    })

    it('retires only the columns the file has caught up to', () => {
      const track = rescan('a.flac', { title: 'Old', trackNo: 1 })
      store.setOverrides([track], { title: 'New', trackNo: 5 }, NOW)

      // The file gained the title but not the track number.
      rescan('a.flac', { title: 'New', trackNo: 1 })

      expect(overrideCount(track)).toBe(1)
      expect(trackById(track).modified).toBe(true)
      const state = store.overrideEditState([track])
      expect(state.title.overridden).toBe(false)
      expect(state.trackNo).toMatchObject({ value: 5, overridden: true })
    })

    it('retires a genre override once the file frames the same genres', () => {
      const track = rescan('a.flac', { title: 'Song', genre: 'Rock' })
      store.setOverrides([track], { genre: 'Jazz' }, NOW)
      expect(store.overrideEditState([track]).genre).toMatchObject({ overridden: true })

      rescan('a.flac', { title: 'Song', genre: 'Jazz' })

      expect(overrideCount(track)).toBe(0)
      expect(store.overrideEditState([track]).genre.overridden).toBe(false)
    })

    it('reproduces the corrected library from files alone after a wipe and re-scan', () => {
      // scan → correct → the correction reaches the file → wipe → re-scan.
      const track = rescan('a.flac', { title: 'Old', artist: 'Old' })
      store.setOverrides([track], { title: 'New', artist: 'New' }, NOW)

      // Wipe every library row the way a fresh index would start.
      opened.db.exec('DELETE FROM track_overrides; DELETE FROM tracks')

      // Re-scan the file, which now carries the flushed correction.
      const rescanned = rescan('a.flac', { title: 'New', artist: 'New' })

      expect(trackById(rescanned).title).toBe('New')
      expect(trackById(rescanned).artist).toBe('New')
      expect(overrideCount(rescanned)).toBe(0)
      expect(store.pendingWritebackTrackIds()).toEqual([])
    })
  })

  /**
   * The artwork override layer — **W16-9**, design authority D28 / Decision A.
   *
   * A cover is a persistent correction like every text field: tri-state (set /
   * clear / absent), resolved through the same `oscine://` path so it shows the
   * moment it is set, and refcounted so the originals GC can release it.
   */
  describe('artwork overrides', () => {
    const HASH_A = 'a'.repeat(64)
    const HASH_B = 'b'.repeat(64)
    const ALBUM_HASH = 'c'.repeat(64)

    function coverHashOf(track: number): string {
      // The `oscine://artwork/<hash>/small` the renderer draws — the override-aware
      // resolution collapses to the hash in the URL.
      const match = /artwork\/([^/]+)\/small$/.exec(trackById(track).artwork.small)
      return match![1]
    }

    it('sets, reads and removes a per-track cover override', () => {
      const track = insertTrack('a.flac', { title: 'Song' })

      expect(store.getArtworkOverride(track)).toBeNull()

      store.setArtworkOverride(track, HASH_A, 'image/jpeg', NOW)
      expect(store.getArtworkOverride(track)).toEqual({ imageHash: HASH_A, mime: 'image/jpeg' })

      store.removeArtworkOverride(track)
      expect(store.getArtworkOverride(track)).toBeNull()
    })

    it('distinguishes a clear (row, null hash) from absent (no row)', () => {
      const track = insertTrack('a.flac', { title: 'Song' })

      store.clearArtworkOverride(track, NOW)
      expect(store.getArtworkOverride(track)).toEqual({ imageHash: null, mime: null })

      const rows = opened.db
        .prepare('SELECT COUNT(*) AS n FROM artwork_overrides WHERE track_id = ?')
        .get(track) as { n: number }
      expect(rows.n).toBe(1)
    })

    it('resolves the track cover to a set override, then back to the album on remove', () => {
      const artist = insertArtist('Artist')
      const album = insertAlbum('Album', artist, 2001)
      const track = insertTrack('a.flac', { title: 'Song', artistId: artist, albumId: album })
      store.setAlbumArtwork(album, ALBUM_HASH)

      expect(coverHashOf(track)).toBe(ALBUM_HASH)

      store.setArtworkOverride(track, HASH_B, 'image/png', NOW)
      expect(coverHashOf(track)).toBe(HASH_B)

      store.removeArtworkOverride(track)
      expect(coverHashOf(track)).toBe(ALBUM_HASH)
    })

    it('resolves a cleared cover to no art, over the album that has some', () => {
      const artist = insertArtist('Artist')
      const album = insertAlbum('Album', artist, 2001)
      const track = insertTrack('a.flac', { title: 'Song', artistId: artist, albumId: album })
      store.setAlbumArtwork(album, ALBUM_HASH)

      store.clearArtworkOverride(track, NOW)

      // The 'missing' sentinel from `artworkUrl(null)` — the cover is blank now,
      // not the album's own art.
      expect(coverHashOf(track)).toBe('missing')
    })

    it('re-choosing a cover replaces the hash in place', () => {
      const track = insertTrack('a.flac', { title: 'Song' })
      store.setArtworkOverride(track, HASH_A, 'image/jpeg', NOW)
      store.setArtworkOverride(track, HASH_B, 'image/png', NOW + 1)

      expect(store.getArtworkOverride(track)).toEqual({ imageHash: HASH_B, mime: 'image/png' })
      const rows = opened.db
        .prepare('SELECT COUNT(*) AS n FROM artwork_overrides WHERE track_id = ?')
        .get(track) as { n: number }
      expect(rows.n).toBe(1)
    })

    it('reports only set hashes as referenced — a clear releases its bytes', () => {
      const t1 = insertTrack('a.flac', { title: 'One' })
      const t2 = insertTrack('b.flac', { title: 'Two' })
      const t3 = insertTrack('c.flac', { title: 'Three' })
      store.setArtworkOverride(t1, HASH_A, 'image/jpeg', NOW)
      store.setArtworkOverride(t2, HASH_A, 'image/jpeg', NOW) // shared album cover, one hash
      store.clearArtworkOverride(t3, NOW)

      expect(store.listReferencedOverrideImageHashes()).toEqual(new Set([HASH_A]))
    })

    it('lists reconcile targets with rejoined absolute paths and no stored abs path', () => {
      const track = insertTrack('Album/01.flac', { title: 'Song' })
      store.setArtworkOverride(track, HASH_A, 'image/jpeg', NOW)

      const targets = store.listArtworkOverrideTargets()
      expect(targets).toHaveLength(1)
      expect(targets[0]).toMatchObject({ trackId: track, imageHash: HASH_A })
      // Rejoined from (root path, rel_path); the root here is '/synthetic'.
      expect(targets[0].absPath).toBe('/synthetic/Album/01.flac')
    })
  })
})
