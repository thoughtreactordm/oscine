import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { LibraryStore } from '../../../src/main/library/store'
import type { TrackTags } from '../../../src/main/library/metadata'

/**
 * D25/D26's read side: Recent Additions orders albums by `MAX(indexed_at)` over
 * their tracks, newest arrival first. A rescan moves `mtime` but not
 * `indexed_at`, so it must not reorder the list; a genuinely new track on an old
 * album, arriving now, must lift that album to the front — that is what
 * `MAX(indexed_at)` and not the album's first track buys.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fermata-recent-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function tags(overrides: Partial<TrackTags> = {}): TrackTags {
  return {
    title: 'A Track',
    artist: 'An Artist',
    album: 'An Album',
    albumArtist: 'An Artist',
    trackNo: 1,
    discNo: null,
    year: 2001,
    durationMs: 60_000,
    codec: 'flac',
    sampleRate: 44_100,
    channels: 2,
    bitDepth: 16,
    genre: null,
    replayGain: null,
    ...overrides
  }
}

function scanned(relPath: string, overrides: Partial<TrackTags> = {}) {
  return {
    file: { absPath: `/music/${relPath}`, relPath, size: 1000, mtime: 1 },
    tags: tags(overrides)
  }
}

function addRoot(db: Database.Database): number {
  return Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', '/music', 1).lastInsertRowid
  )
}

describe('recentlyAddedAlbums', () => {
  let opened: OpenDatabaseResult
  let store: LibraryStore
  let rootId: number

  beforeEach(() => {
    opened = openDatabase(join(dir, 'library.db'))
    rootId = addRoot(opened.db)
    store = new LibraryStore(opened.db)
  })

  afterEach(() => {
    opened.db.close()
  })

  const albumId = (title: string): number =>
    (opened.db.prepare('SELECT id FROM albums WHERE title = ?').get(title) as { id: number }).id

  it('orders albums by arrival, newest first, with the album fields on each row', () => {
    store.writeTracks(
      rootId,
      [scanned('old.flac', { album: 'Old', albumArtist: 'X', year: 1990 })],
      100
    )
    store.writeTracks(
      rootId,
      [scanned('mid.flac', { album: 'Mid', albumArtist: 'Y', year: 2000 })],
      200
    )
    store.writeTracks(
      rootId,
      [scanned('new.flac', { album: 'New', albumArtist: 'Z', year: 2010 })],
      300
    )

    const albums = store.recentlyAddedAlbums(10)

    expect(albums.map((a) => a.title)).toEqual(['New', 'Mid', 'Old'])
    expect(albums[0]).toEqual({
      albumId: albumId('New'),
      title: 'New',
      artist: 'Z',
      year: 2010,
      artworkHash: null,
      addedAt: 300
    })
  })

  it('carries the album artwork hash through', () => {
    store.writeTracks(rootId, [scanned('a.flac', { album: 'Art', albumArtist: 'X' })], 100)
    store.setAlbumArtwork(albumId('Art'), 'deadbeef')

    expect(store.recentlyAddedAlbums(10)[0].artworkHash).toBe('deadbeef')
  })

  it('leaves artist null when the album has no artist to name it', () => {
    // No performer and no album artist — the writer resolves album_artist_id to
    // NULL, and the projection leaves `artist` null rather than inventing one.
    store.writeTracks(
      rootId,
      [scanned('a.flac', { album: 'Anon', artist: null, albumArtist: null })],
      100
    )

    expect(store.recentlyAddedAlbums(10)[0].artist).toBeNull()
  })

  it('ranks an album by its newest track, not its first — MAX(indexed_at)', () => {
    store.writeTracks(rootId, [scanned('old-1.flac', { album: 'Old', albumArtist: 'X' })], 100)
    store.writeTracks(rootId, [scanned('new.flac', { album: 'New', albumArtist: 'Z' })], 300)
    // A genuinely new track lands on the old album now — later than everything.
    store.writeTracks(rootId, [scanned('old-2.flac', { album: 'Old', albumArtist: 'X' })], 400)

    const albums = store.recentlyAddedAlbums(10)
    expect(albums.map((a) => a.title)).toEqual(['Old', 'New'])
    expect(albums[0].addedAt).toBe(400)
  })

  it('caps the list at the requested limit', () => {
    for (let i = 0; i < 5; i++) {
      store.writeTracks(
        rootId,
        [scanned(`t${i}.flac`, { album: `Album ${i}`, albumArtist: 'X' })],
        100 + i
      )
    }

    expect(store.recentlyAddedAlbums(3)).toHaveLength(3)
  })
})
