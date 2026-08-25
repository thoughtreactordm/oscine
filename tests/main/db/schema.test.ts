import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MIGRATIONS, migrate, openDatabase } from '../../../src/main/db'

/**
 * The head schema version, read from the registry rather than written down.
 *
 * `migrate` already refuses a registry whose versions are not contiguous, so
 * the length *is* the head version and an assertion restating it as a literal
 * only buys four files to edit per migration. The ordered list of names below
 * is the assertion worth having: it says which migrations ran, and in what
 * order, which the length cannot.
 */
const HEAD = MIGRATIONS.length

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oscine-test-'))
  file = join(dir, 'library.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Inserts a root and one track hanging off it, returning both ids. */
function seedRootAndTrack(db: ReturnType<typeof openDatabase>['db']): {
  rootId: number
  trackId: number
} {
  const rootId = Number(
    db
      .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
      .run('Music', '/srv/music', Date.now()).lastInsertRowid
  )
  const trackId = Number(
    db
      .prepare('INSERT INTO tracks (root_id, rel_path, mtime, size) VALUES (?, ?, ?, ?)')
      .run(rootId, 'a/b.flac', 1, 2).lastInsertRowid
  )
  return { rootId, trackId }
}

describe('openDatabase', () => {
  it('creates the database and applies every migration on first launch', () => {
    const { db, migration } = openDatabase(file)
    try {
      expect(migration.from).toBe(0)
      expect(migration.to).toBe(HEAD)
      expect(migration.applied.map((m) => m.name)).toEqual([
        'schema-v1',
        'index-track-order',
        'replaygain-jobs',
        'trigram-search',
        'podcasts',
        'settings',
        'crossfade-cascade',
        'theme-keys',
        'play-history',
        'track-genre',
        'artist-mbid',
        'scrobble-outbox',
        'track-genres',
        'listens-log',
        'favorites',
        'quick-access'
      ])
      expect(db.pragma('user_version', { simple: true })).toBe(HEAD)
    } finally {
      db.close()
    }
  })

  it('is a no-op on second launch', () => {
    const first = openDatabase(file)
    first.db.close()

    const { db, migration } = openDatabase(file)
    try {
      expect(migration.from).toBe(HEAD)
      expect(migration.to).toBe(HEAD)
      expect(migration.applied).toEqual([])
    } finally {
      db.close()
    }
  })

  it('adds the ordering indexes to an existing library without losing rows', () => {
    const old = new Database(file)
    migrate(old, MIGRATIONS.slice(0, 1))
    const seeded = seedRootAndTrack(old)
    old.close()

    const { db, migration } = openDatabase(file)
    try {
      expect(migration.from).toBe(1)
      expect(migration.to).toBe(HEAD)
      expect(migration.applied.map((m) => m.name)).toEqual([
        'index-track-order',
        'replaygain-jobs',
        'trigram-search',
        'podcasts',
        'settings',
        'crossfade-cascade',
        'theme-keys',
        'play-history',
        'track-genre',
        'artist-mbid',
        'scrobble-outbox',
        'track-genres',
        'listens-log',
        'favorites',
        'quick-access'
      ])
      expect(db.prepare('SELECT id FROM tracks').get()).toEqual({ id: seeded.trackId })
    } finally {
      db.close()
    }
  })

  it('transactionally rebuilds an existing token index as trigram search', () => {
    const old = new Database(file)
    migrate(old, MIGRATIONS.slice(0, 3))
    const { rootId, trackId } = seedRootAndTrack(old)
    old.prepare('UPDATE tracks SET title = ? WHERE id = ?').run('Bohemian Rhapsody', trackId)
    old
      .prepare(
        "INSERT INTO tracks_fts(rowid, title, artist, album) VALUES (?, 'Bohemian Rhapsody', '', '')"
      )
      .run(trackId)
    old.close()

    const { db, migration } = openDatabase(file)
    try {
      expect(migration.from).toBe(3)
      expect(migration.applied.map((step) => step.name)).toEqual([
        'trigram-search',
        'podcasts',
        'settings',
        'crossfade-cascade',
        'theme-keys',
        'play-history',
        'track-genre',
        'artist-mbid',
        'scrobble-outbox',
        'track-genres',
        'listens-log',
        'favorites',
        'quick-access'
      ])
      expect(
        db.prepare("SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH 'hemian'").get()
      ).toEqual({ rowid: trackId })
      expect(db.prepare('SELECT root_id AS rootId FROM tracks WHERE id = ?').get(trackId)).toEqual({
        rootId
      })
    } finally {
      db.close()
    }
  })

  it('creates every table schema v1 specifies', () => {
    const { db } = openDatabase(file)
    try {
      const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name")
        .all()
        .map((row) => (row as { name: string }).name)

      for (const table of [
        'roots',
        'artists',
        'albums',
        'tracks',
        'track_overrides',
        'playlists',
        'playlist_entries',
        'tracks_fts',
        'replaygain_jobs',
        'replaygain_job_items'
      ]) {
        expect(names).toContain(table)
      }
    } finally {
      db.close()
    }
  })

  it('creates indexes covering every library ordering', () => {
    const { db } = openDatabase(file)
    try {
      const names = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all()
        .map((row) => (row as { name: string }).name)

      for (const index of [
        'idx_tracks_order_title_asc',
        'idx_tracks_order_title_desc',
        'idx_tracks_order_duration_asc',
        'idx_tracks_order_duration_desc',
        'idx_tracks_order_number_asc',
        'idx_tracks_order_number_desc',
        'idx_artists_order_name',
        'idx_albums_order_title',
        'idx_tracks_root_artist',
        'idx_tracks_root_album',
        'idx_tracks_artist_album'
      ]) {
        expect(names).toContain(index)
      }
    } finally {
      db.close()
    }
  })

  /**
   * R5's identity columns, and the partial index W7-11 will read them backwards
   * through. Asserted here rather than only in the migration's own tests because
   * this file is the one place that says what the head schema *is*.
   */
  it('carries the artist identity columns and their index', () => {
    const { db } = openDatabase(file)
    try {
      const columns = (db.pragma('table_info(artists)') as { name: string }[]).map(
        (row) => row.name
      )
      expect(columns).toContain('mbid')
      expect(columns).toContain('mbid_source')

      const index = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('idx_artists_mbid') as { sql: string } | undefined
      // Partial: the column is NULL for every artist nothing has resolved yet,
      // and a full index over mostly-NULL rows is a table copy for nothing.
      expect(index?.sql).toContain('WHERE mbid IS NOT NULL')
    } finally {
      db.close()
    }
  })

  /**
   * Migration 013's derived table. Here, like the artist columns above, because
   * this file is the one place that says what the head schema *is* — and because
   * `WITHOUT ROWID` and the covering index are both properties a later migration
   * could drop by accident while its own tests kept passing.
   */
  it('carries the genre join table, keyed for the histogram', () => {
    const { db } = openDatabase(file)
    try {
      const table = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('track_genres') as { sql: string } | undefined
      expect(table?.sql).toContain('WITHOUT ROWID')

      const index = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('idx_track_genres_key') as { sql: string } | undefined
      // Key first, track id second: that ordering is what makes "count tracks
      // per genre" an index-only scan rather than a walk of the table.
      expect(index?.sql).toContain('(genre_key, track_id)')
    } finally {
      db.close()
    }
  })

  /**
   * Migration 014. Every property asserted here is one a later migration could
   * drop by accident while its own tests kept passing — and each one is load
   * bearing for a different reason, so they are named rather than counted.
   */
  it('carries the listens log, severable and snapshot-carrying', () => {
    const { db } = openDatabase(file)
    try {
      const listens = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('listens') as { sql: string } | undefined
      // The whole of D17 rests on this clause. CASCADE here would mean a folder
      // reorganisation silently deleting years of history.
      expect(listens?.sql).toContain('ON DELETE SET NULL')

      const keys = db.pragma('foreign_key_list(listens)') as {
        table: string
        from: string
        on_delete: string
      }[]
      expect(keys).toEqual([expect.objectContaining({ table: 'tracks', from: 'track_id' })])
      expect(keys[0].on_delete).toBe('SET NULL')

      const indexes = new Map(
        (
          db
            .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
            .all('listens') as { name: string; sql: string | null }[]
        ).map((row) => [row.name, row.sql])
      )
      expect(indexes.get('idx_listens_started')).toContain('(started_at)')
      // The child side of the SET NULL reference: SQLite indexes the parent of a
      // reference and never the child, so without this every track deletion
      // during a scan is a full scan of the largest table in the database.
      expect(indexes.get('idx_listens_track')).toContain('(track_id, started_at)')
      // UNIQUE is what makes a D11 import INSERT OR IGNORE, so merging twice is
      // merging once.
      expect(indexes.get('idx_listens_identity')).toContain('UNIQUE')
      expect(indexes.get('idx_listens_identity')).toContain('(started_at, title, artist_name)')
      // Deliberately absent until a query is measured slow, not overlooked.
      expect([...indexes.keys()].sort()).toEqual([
        'idx_listens_identity',
        'idx_listens_started',
        'idx_listens_track'
      ])

      const genres = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('listen_genres') as { sql: string } | undefined
      expect(genres?.sql).toContain('WITHOUT ROWID')
      // Cascading here, unlike listens itself: a genre row with no listen to
      // hang off is not history, it is a leak.
      expect(genres?.sql).toContain('ON DELETE CASCADE')

      const genreIndex = db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get('idx_listen_genres_key') as { sql: string } | undefined
      // Key first, listen id second: "top genres in this window" reads the index
      // and never the table.
      expect(genreIndex?.sql).toContain('(genre_key, listen_id)')
    } finally {
      db.close()
    }
  })

  it('enables WAL, which persists in the file', () => {
    const { db } = openDatabase(file)
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
    } finally {
      db.close()
    }
  })

  it('enables foreign_keys on every connection', () => {
    // Weak on its own: better-sqlite3 defaults this on, so it would pass even
    // without our pragma. The cascade tests below are what actually prove the
    // constraint is live. This one guards the reopen case — the pragma is
    // per-connection, never stored in the file.
    for (let i = 0; i < 2; i++) {
      const { db } = openDatabase(file)
      try {
        expect(db.pragma('foreign_keys', { simple: true })).toBe(1)
      } finally {
        db.close()
      }
    }
  })

  it('accepts a searchable row in tracks_fts', () => {
    const { db } = openDatabase(file)
    try {
      // Contentless FTS5: rowid is supplied by the caller (W2-2 uses track id).
      db.prepare(
        "INSERT INTO tracks_fts (rowid, title, artist, album) VALUES (1, 'Julie and Candy', 'Boards of Canada', 'Geogaddi')"
      ).run()
      const hit = db.prepare("SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH 'julie'").get()
      expect(hit).toEqual({ rowid: 1 })
    } finally {
      db.close()
    }
  })

  it('folds diacritics, per the configured tokenizer', () => {
    const { db } = openDatabase(file)
    try {
      db.prepare(
        "INSERT INTO tracks_fts (rowid, title, artist, album) VALUES (1, 'Samskeyti', 'Sigur Rós', '( )')"
      ).run()
      // remove_diacritics 2 is what makes this match; searching for an artist
      // exactly as spelled is not something a keyboard makes easy.
      const hit = db.prepare("SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH 'ros'").get()
      expect(hit).toEqual({ rowid: 1 })
    } finally {
      db.close()
    }
  })

  it('finds a true mid-token infix with the trigram tokenizer', () => {
    const { db } = openDatabase(file)
    try {
      db.prepare(
        "INSERT INTO tracks_fts (rowid, title, artist, album) VALUES (1, 'Bohemian Rhapsody', 'Queen', 'A Night at the Opera')"
      ).run()
      const hit = db.prepare("SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH 'hemian'").get()
      expect(hit).toEqual({ rowid: 1 })
    } finally {
      db.close()
    }
  })
})

/**
 * Migration 016's backfill (D25). The arrival clock is derived, not observed,
 * for every row that predates the column: a root's `added_at` is the nearest
 * honest answer, and a single migration-time `nowMs` is the floor for a row
 * whose root cannot be resolved at all.
 */
describe('migration 016 backfills indexed_at', () => {
  /** Migrations strictly before `quick-access`, found rather than written down. */
  const BEFORE_016 = MIGRATIONS.findIndex((step) => step.name === 'quick-access')

  function seedRoot(db: Database.Database, path: string, addedAt: number): number {
    return Number(
      db
        .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
        .run(path, path, addedAt).lastInsertRowid
    )
  }

  function seedTrack(db: Database.Database, rootId: number, relPath: string): number {
    return Number(
      db
        .prepare('INSERT INTO tracks (root_id, rel_path, mtime, size) VALUES (?, ?, ?, ?)')
        .run(rootId, relPath, 1, 2).lastInsertRowid
    )
  }

  it('resolves each row from its root, and falls back to one nowMs for the rootless', () => {
    const old = new Database(file)
    // Off, so the orphan below can exist: deleting its root must not cascade the
    // track away, since a rootless row is the only way to reach the fallback.
    old.pragma('foreign_keys = OFF')
    migrate(old, MIGRATIONS.slice(0, BEFORE_016))
    expect(old.pragma('user_version', { simple: true })).toBe(BEFORE_016)

    const rootA = seedRoot(old, '/a', 1000)
    const rootB = seedRoot(old, '/b', 2000)
    const rootC = seedRoot(old, '/c', 3000)
    const trackA = seedTrack(old, rootA, 'a.flac')
    const trackB = seedTrack(old, rootB, 'b.flac')
    const orphan = seedTrack(old, rootC, 'c.flac')
    // The root vanishes but its track does not — a row whose `added_at` no longer
    // resolves, so the `COALESCE` fallback is the only branch that can stamp it.
    old.prepare('DELETE FROM roots WHERE id = ?').run(rootC)

    const before = Date.now()
    migrate(old, MIGRATIONS)
    const after = Date.now()

    const indexedAt = (id: number): number =>
      (old.prepare('SELECT indexed_at AS at FROM tracks WHERE id = ?').get(id) as { at: number }).at

    try {
      expect(indexedAt(trackA)).toBe(1000)
      expect(indexedAt(trackB)).toBe(2000)
      const fallback = indexedAt(orphan)
      expect(fallback).toBeGreaterThanOrEqual(before)
      expect(fallback).toBeLessThanOrEqual(after)
    } finally {
      old.close()
    }
  })
})

/**
 * These are the tests that prove `PRAGMA foreign_keys = ON` actually took
 * effect. Without it the schema still builds and every cascade below silently
 * becomes a no-op, leaving orphaned rows that only surface much later.
 */
describe('referential integrity', () => {
  it('cascades a root deletion to its tracks', () => {
    const { db } = openDatabase(file)
    try {
      const { rootId } = seedRootAndTrack(db)
      expect(db.prepare('SELECT count(*) n FROM tracks').get()).toEqual({ n: 1 })

      db.prepare('DELETE FROM roots WHERE id = ?').run(rootId)

      expect(db.prepare('SELECT count(*) n FROM tracks').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })

  it('cascades a track deletion to its overrides and playlist entries', () => {
    const { db } = openDatabase(file)
    try {
      const { trackId } = seedRootAndTrack(db)
      const playlistId = Number(
        db
          .prepare(
            'INSERT INTO playlists (name, position, created_at, updated_at) VALUES (?, ?, ?, ?)'
          )
          .run('Favourites', 0, 1, 1).lastInsertRowid
      )
      db.prepare('INSERT INTO track_overrides (track_id, title, updated_at) VALUES (?, ?, ?)').run(
        trackId,
        'Corrected',
        1
      )
      db.prepare(
        'INSERT INTO playlist_entries (playlist_id, track_id, position) VALUES (?, ?, ?)'
      ).run(playlistId, trackId, 1.5)

      db.prepare('DELETE FROM tracks WHERE id = ?').run(trackId)

      expect(db.prepare('SELECT count(*) n FROM track_overrides').get()).toEqual({ n: 0 })
      expect(db.prepare('SELECT count(*) n FROM playlist_entries').get()).toEqual({ n: 0 })
      // The playlist itself outlives its entries.
      expect(db.prepare('SELECT count(*) n FROM playlists').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('severs a track deletion from its listens, leaving the snapshot whole', () => {
    const { db } = openDatabase(file)
    try {
      const { rootId, trackId } = seedRootAndTrack(db)
      const listenId = Number(
        db
          .prepare(
            `INSERT INTO listens
               (track_id, started_at, ms_listened, duration_ms,
                title, artist_name, album_title, album_artist_name)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            trackId,
            1_700_000_000_000,
            184_000,
            201_000,
            'Windowlicker',
            'Aphex Twin',
            'EP',
            'Aphex Twin'
          ).lastInsertRowid
      )
      db.prepare('INSERT INTO listen_genres (listen_id, genre_key, genre) VALUES (?, ?, ?)').run(
        listenId,
        'idm',
        'IDM'
      )

      // A folder reorganisation, as the scanner sees it: the file is gone from
      // the root, so the root goes and the track goes with it.
      db.prepare('DELETE FROM roots WHERE id = ?').run(rootId)

      expect(db.prepare('SELECT count(*) n FROM tracks').get()).toEqual({ n: 0 })
      expect(
        db
          .prepare(
            `SELECT track_id AS trackId, started_at AS startedAt, ms_listened AS msListened,
                    duration_ms AS durationMs, title, artist_name AS artistName,
                    album_title AS albumTitle, album_artist_name AS albumArtistName
             FROM listens WHERE id = ?`
          )
          .get(listenId)
      ).toEqual({
        trackId: null,
        startedAt: 1_700_000_000_000,
        msListened: 184_000,
        durationMs: 201_000,
        title: 'Windowlicker',
        artistName: 'Aphex Twin',
        albumTitle: 'EP',
        albumArtistName: 'Aphex Twin'
      })
      // The genre snapshot survives too, or "top genres of 2026" would rewrite
      // itself every time the operator moved a folder.
      expect(db.prepare('SELECT count(*) n FROM listen_genres').get()).toEqual({ n: 1 })
      // A severed reference is not a broken one.
      expect(db.pragma('foreign_key_check')).toEqual([])

      db.prepare('DELETE FROM listens WHERE id = ?').run(listenId)
      expect(db.prepare('SELECT count(*) n FROM listen_genres').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })

  it('cascades a playlist deletion to its entries', () => {
    const { db } = openDatabase(file)
    try {
      const { trackId } = seedRootAndTrack(db)
      const playlistId = Number(
        db
          .prepare(
            'INSERT INTO playlists (name, position, created_at, updated_at) VALUES (?, ?, ?, ?)'
          )
          .run('Favourites', 0, 1, 1).lastInsertRowid
      )
      db.prepare(
        'INSERT INTO playlist_entries (playlist_id, track_id, position) VALUES (?, ?, ?)'
      ).run(playlistId, trackId, 1)

      db.prepare('DELETE FROM playlists WHERE id = ?').run(playlistId)

      expect(db.prepare('SELECT count(*) n FROM playlist_entries').get()).toEqual({ n: 0 })
      // Deleting a playlist must not delete the music in it.
      expect(db.prepare('SELECT count(*) n FROM tracks').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('cascades a playlist deletion to its favorite star', () => {
    const { db } = openDatabase(file)
    try {
      const playlistId = Number(
        db
          .prepare(
            'INSERT INTO playlists (name, position, created_at, updated_at) VALUES (?, ?, ?, ?)'
          )
          .run('Late night', 0, 1, 1).lastInsertRowid
      )
      db.prepare('INSERT INTO playlist_favorites (playlist_id, favorited_at) VALUES (?, ?)').run(
        playlistId,
        5000
      )

      db.prepare('DELETE FROM playlists WHERE id = ?').run(playlistId)

      expect(db.prepare('SELECT count(*) n FROM playlist_favorites').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })

  it('cascades an artist deletion to its favorite star', () => {
    const { db } = openDatabase(file)
    try {
      const artistId = Number(
        db.prepare('INSERT INTO artists (name) VALUES (?)').run('Boards of Canada').lastInsertRowid
      )
      db.prepare('INSERT INTO artist_favorites (artist_id, favorited_at) VALUES (?, ?)').run(
        artistId,
        5000
      )

      db.prepare('DELETE FROM artists WHERE id = ?').run(artistId)

      expect(db.prepare('SELECT count(*) n FROM artist_favorites').get()).toEqual({ n: 0 })
    } finally {
      db.close()
    }
  })

  it('does not cascade once the pragma is turned off', () => {
    // Negative control. Without this, the cascade tests above could pass for
    // reasons unrelated to foreign keys and nobody would notice; this shows they
    // are actually measuring the constraint.
    const { db } = openDatabase(file)
    try {
      db.pragma('foreign_keys = OFF')
      const { rootId } = seedRootAndTrack(db)

      db.prepare('DELETE FROM roots WHERE id = ?').run(rootId)

      expect(db.prepare('SELECT count(*) n FROM tracks').get()).toEqual({ n: 1 })
    } finally {
      db.close()
    }
  })

  it('refuses a track pointing at a root that does not exist', () => {
    const { db } = openDatabase(file)
    try {
      expect(() =>
        db
          .prepare('INSERT INTO tracks (root_id, rel_path, mtime, size) VALUES (?, ?, ?, ?)')
          .run(999, 'a.flac', 1, 2)
      ).toThrow(/FOREIGN KEY/i)
    } finally {
      db.close()
    }
  })

  it('enforces the uniqueness constraints identity depends on', () => {
    const { db } = openDatabase(file)
    try {
      const { rootId } = seedRootAndTrack(db)

      // One row per file: re-scanning must update, not duplicate.
      expect(() =>
        db
          .prepare('INSERT INTO tracks (root_id, rel_path, mtime, size) VALUES (?, ?, ?, ?)')
          .run(rootId, 'a/b.flac', 9, 9)
      ).toThrow(/UNIQUE/i)

      // One row per folder: W2-2 rejects re-adding a root on the strength of this.
      expect(() =>
        db
          .prepare('INSERT INTO roots (label, path, added_at) VALUES (?, ?, ?)')
          .run('Dup', '/srv/music', 1)
      ).toThrow(/UNIQUE/i)
    } finally {
      db.close()
    }
  })
})
