import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate, openDatabase, type OpenDatabaseResult } from '../../../src/main/db'
import { LibraryStore } from '../../../src/main/library/store'
import type { TrackTags } from '../../../src/main/library/metadata'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-genres-'))
  file = join(dir, 'library.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * How many migrations precede `track-genres`, found rather than written down —
 * so appending migration 014 does not silently turn the backfill test into a
 * test of some other upgrade path.
 */
const BEFORE_GENRES = MIGRATIONS.findIndex((step) => step.name === 'track-genres')

function tags(genre: string | null): TrackTags {
  return {
    title: 'Ready Lets Go',
    artist: 'Boards of Canada',
    album: 'Geogaddi',
    albumArtist: 'Boards of Canada',
    trackNo: 1,
    discNo: null,
    year: 2002,
    durationMs: 60_000,
    codec: 'flac',
    sampleRate: 44_100,
    channels: 2,
    bitDepth: 16,
    genre,
    replayGain: null
  }
}

function scanned(
  relPath: string,
  genre: string | null
): {
  file: { absPath: string; relPath: string; size: number; mtime: number }
  tags: TrackTags
} {
  return {
    file: { absPath: `/music/${relPath}`, relPath, size: 1000, mtime: 1 },
    tags: tags(genre)
  }
}

function addRoot(db: Database.Database): number {
  return Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', '/music', 1).lastInsertRowid
  )
}

/** Every genre row in the database, ordered so assertions can be literal. */
function allGenres(db: Database.Database): { trackId: number; key: string; genre: string }[] {
  return db
    .prepare(
      `SELECT track_id AS trackId, genre_key AS key, genre
       FROM track_genres ORDER BY track_id, genre_key`
    )
    .all() as { trackId: number; key: string; genre: string }[]
}

describe('track_genres, written by the scanner', () => {
  let opened: OpenDatabaseResult
  let store: LibraryStore
  let rootId: number

  beforeEach(() => {
    opened = openDatabase(file)
    rootId = addRoot(opened.db)
    store = new LibraryStore(opened.db)
  })

  afterEach(() => {
    opened.db.close()
  })

  it('splits a multi-valued tag into one row per genre', () => {
    store.writeTracks(rootId, [scanned('a.flac', 'Rock; Alternative')])

    expect(
      allGenres(opened.db)
        .map((row) => row.genre)
        .sort()
    ).toEqual(['Alternative', 'Rock'])
  })

  it('writes nothing for a track with no genre', () => {
    store.writeTracks(rootId, [scanned('a.flac', null)])

    expect(allGenres(opened.db)).toEqual([])
  })

  /**
   * The property that makes the table derived rather than authored: a rescan of
   * a retagged file has to leave the old genres gone, not merged with the new.
   */
  it("replaces a track's genres on re-upsert rather than accumulating them", () => {
    store.writeTracks(rootId, [scanned('a.flac', 'Rock; Alternative')])
    store.writeTracks(rootId, [scanned('a.flac', 'Ambient')])

    expect(allGenres(opened.db).map((row) => row.key)).toEqual(['ambient'])
  })

  it('upserting an unchanged track twice does not duplicate its rows', () => {
    store.writeTracks(rootId, [scanned('a.flac', 'IDM')])
    store.writeTracks(rootId, [scanned('a.flac', 'IDM')])

    expect(allGenres(opened.db)).toHaveLength(1)
  })

  it('cascades when the track is deleted', () => {
    store.writeTracks(rootId, [scanned('a.flac', 'IDM'), scanned('b.flac', 'Ambient')])
    store.deleteTracks(rootId, ['a.flac'])

    expect(allGenres(opened.db).map((row) => row.key)).toEqual(['ambient'])
  })

  it('cascades through the track when the root is removed', () => {
    store.writeTracks(rootId, [scanned('a.flac', 'IDM')])
    opened.db.prepare('DELETE FROM roots WHERE id = ?').run(rootId)

    expect(allGenres(opened.db)).toEqual([])
  })

  /** The point of the whole table: two spellings, one thing to group by. */
  it('groups two tracks tagged differently under one key', () => {
    store.writeTracks(rootId, [scanned('a.flac', 'IDM'), scanned('b.flac', 'idm')])

    expect(
      opened.db
        .prepare('SELECT genre_key AS key, COUNT(*) AS n FROM track_genres GROUP BY genre_key')
        .all()
    ).toEqual([{ key: 'idm', n: 2 }])
  })

  /**
   * `genre` is per row, not per key — the primary key is `(track_id,
   * genre_key)`, so two tracks tagged differently keep their own spellings and
   * anything rendering a key has to choose one. Asserted so that a reader of the
   * schema comment's "canonical display spelling" knows how far it goes: within
   * a track, not across the library. Cross-library canonicalisation is the
   * operator alias map, which is a later card.
   */
  it('keeps each track its own spelling of a shared key', () => {
    store.writeTracks(rootId, [scanned('a.flac', 'IDM'), scanned('b.flac', 'idm')])

    expect(allGenres(opened.db).map((row) => row.genre)).toEqual(['IDM', 'idm'])
  })

  /**
   * W12-8 denormalized `tracks.album_id` onto `track_genres` so genre-roulette's
   * pool gate walks a covering index instead of correlating back to `tracks`.
   * The scanner writes the column; a direct retarget of `tracks.album_id` (the
   * W16 write-back paths, which never rebuild `track_genres`) is mirrored by the
   * schema's sync trigger. Both are asserted because a desync here is silent —
   * the recipe would just quietly bucket albums wrong.
   */
  it('stamps each genre row with the track album_id at scan time', () => {
    store.writeTracks(rootId, [scanned('a.flac', 'Rock; Alternative')])

    const albumId = (
      opened.db.prepare("SELECT album_id AS id FROM tracks WHERE rel_path = 'a.flac'").get() as {
        id: number
      }
    ).id
    const stamped = opened.db.prepare('SELECT DISTINCT album_id AS id FROM track_genres').all() as {
      id: number
    }[]
    expect(stamped).toEqual([{ id: albumId }])
  })

  it('mirrors a direct album_id retarget onto the genre rows via trigger', () => {
    store.writeTracks(rootId, [scanned('a.flac', 'IDM')])
    const trackId = (
      opened.db.prepare("SELECT id FROM tracks WHERE rel_path = 'a.flac'").get() as { id: number }
    ).id
    const newAlbumId = Number(
      opened.db
        .prepare('INSERT INTO albums (title, album_artist_id, year) VALUES (?, NULL, NULL)')
        .run('Re-homed').lastInsertRowid
    )

    // The shape the write-back paths use: UPDATE tracks.album_id without touching
    // track_genres. The trigger is what keeps the denormalized copy honest.
    opened.db.prepare('UPDATE tracks SET album_id = ? WHERE id = ?').run(newAlbumId, trackId)

    const mirrored = (
      opened.db
        .prepare('SELECT album_id AS id FROM track_genres WHERE track_id = ?')
        .get(trackId) as { id: number }
    ).id
    expect(mirrored).toBe(newAlbumId)
  })
})

describe('migration 013 backfill', () => {
  /**
   * The reason the migration carries a backfill at all: migration 010 left genre
   * to the next rescan because only the file had it, but this table's input is a
   * column the database already holds. Waiting for a rescan here would mean an
   * upgraded library shows an empty genre histogram until the operator guesses
   * which action fixes it.
   */
  it('populates from existing tracks.genre in one pass', () => {
    const old = new Database(file)
    old.pragma('foreign_keys = ON')
    migrate(old, MIGRATIONS.slice(0, BEFORE_GENRES))

    const rootId = addRoot(old)
    const insert = old.prepare(
      'INSERT INTO tracks (root_id, rel_path, mtime, size, title, genre) VALUES (?, ?, 1, 1, ?, ?)'
    )
    insert.run(rootId, 'a.flac', 'A', 'Rock; Alternative')
    insert.run(rootId, 'b.flac', 'B', 'rock')
    insert.run(rootId, 'c.flac', 'C', null)
    insert.run(rootId, 'd.flac', 'D', '')
    old.close()

    const { db, migration } = openDatabase(file)
    try {
      expect(migration.applied.map((step) => step.name)).toContain('track-genres')

      // Three rows over two tracks: `rock` groups across the two spellings while
      // each track keeps its own row, which is what a per-track join table is
      // for. The untagged and empty-tagged tracks contribute nothing.
      expect(
        db
          .prepare(
            `SELECT genre_key AS key, COUNT(*) AS n
             FROM track_genres GROUP BY genre_key ORDER BY key`
          )
          .all()
      ).toEqual([
        { key: 'alternative', n: 1 },
        { key: 'rock', n: 2 }
      ])
    } finally {
      db.close()
    }
  })
})
