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
  dir = mkdtempSync(join(tmpdir(), 'fermata-test-'))
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
        'track-genre'
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
        'track-genre'
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
        'track-genre'
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
