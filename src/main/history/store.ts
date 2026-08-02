import type Database from 'better-sqlite3'
import { PLAY_HISTORY_CAP, type PlayEntry } from '@shared/history'
import { TRACK_JOINS, TRACK_PROJECTION, toTrack, type TrackRow } from '../library/store'

/**
 * Every SQL statement the play-history trail issues. Three of them.
 *
 * Its own module beside `../library/store` rather than four more methods on it,
 * following the precedent `../library/playlists/store` set: this owns one table
 * the library layer never touches, and the library owns the rest. It borrows
 * the track projection rather than restating it, for the reason stated on
 * `TRACK_PROJECTION` — a second copy of those columns is a second copy that
 * stops matching, and the symptom would be a trail with no artwork.
 *
 * Electron-free, so the whole thing is drivable under plain Node against a temp
 * file.
 */

interface HistoryRow extends TrackRow {
  historyId: number
  playedAt: number
}

export class PlayHistoryStore {
  private readonly statements: {
    insert: Database.Statement
    evict: Database.Statement
    read: Database.Statement<[number]>
    clear: Database.Statement
  }

  constructor(
    db: Database.Database,
    /** Overridable so a test can drive eviction without five hundred inserts. */
    private readonly cap: number = PLAY_HISTORY_CAP
  ) {
    this.statements = {
      // Conditional on the track still existing rather than letting the foreign
      // key decide. `foreign_keys = ON` would turn a race with a rescan into a
      // thrown constraint error over a track that is still audible; this makes
      // it a `changes` of zero, which is what it actually is.
      insert: db.prepare(`
        INSERT INTO play_history (track_id, played_at)
        SELECT ?, ? WHERE EXISTS (SELECT 1 FROM tracks WHERE id = ?)
      `),
      // Eviction from the bottom, by a range of the rowid rather than by
      // `NOT IN (SELECT ... LIMIT cap)`. Two properties make it exact: ids are
      // monotonic because nothing is ever deleted from the top, so "older" and
      // "lower id" are the same statement; and below the cap the bound goes
      // negative and this is an index seek that matches nothing.
      evict: db.prepare('DELETE FROM play_history WHERE id <= ?'),
      read: db.prepare(`
        SELECT
          h.id        AS historyId,
          h.played_at AS playedAt,
          ${TRACK_PROJECTION}
        FROM play_history h
        JOIN tracks t ON t.id = h.track_id
        ${TRACK_JOINS}
        ORDER BY h.id DESC
        LIMIT ?
      `),
      clear: db.prepare('DELETE FROM play_history')
    }
  }

  /**
   * Appends one play and evicts anything past the cap.
   *
   * `null` when the track id is not in the library — a race with a rescan that
   * removed the file out from under a track that was already playing. That is
   * an ordinary outcome rather than a fault: the renderer reports a play it
   * genuinely started, and there is simply nothing left to record it against.
   */
  record(trackId: number, playedAt: number): PlayEntry | null {
    const inserted = this.statements.insert.run(trackId, playedAt, trackId)
    if (inserted.changes === 0) return null

    const id = Number(inserted.lastInsertRowid)
    this.statements.evict.run(id - this.cap)

    // Read back rather than composing the entry here: the row the trail shows
    // is the joined display row, and building a second version of it from the
    // id alone is the drift `TRACK_PROJECTION` exists to prevent.
    return this.list(1)[0] ?? null
  }

  /** The trail, most recent first. `limit` is clamped by the service. */
  list(limit: number): PlayEntry[] {
    const rows = this.statements.read.all(limit) as HistoryRow[]
    return rows.map((row) => ({
      id: row.historyId,
      playedAt: row.playedAt,
      track: toTrack(row)
    }))
  }

  clear(): void {
    this.statements.clear.run()
  }
}
