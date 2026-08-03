import type Database from 'better-sqlite3'
import type { ListenCommit, RecordListenRequest } from '@shared/listens'

/**
 * The listen commit, and the four statements it is made of.
 *
 * Its own module beside `../history/store` rather than more methods on the
 * library store, following the precedent `../library/playlists/store` set: this
 * owns two tables the library layer never touches. It does *not* borrow
 * `TRACK_PROJECTION`, and that is deliberate rather than an oversight — the
 * projection resolves a track as it is indexed now, and every column here is a
 * snapshot of how it read at listen time, resolved through `track_overrides`.
 * The two want opposite things from the same joins.
 *
 * Electron-free, so the whole thing is drivable under plain Node against a temp
 * file.
 *
 * ## One transaction
 *
 * The insert, the genre copy and the play-count bump are one atomic unit. A
 * listen with no genres because the second statement failed is a hole in a
 * chart that nothing will ever notice, and a `play_count` that counted a listen
 * the log does not hold breaks the property D17 leans on — that the counters on
 * `tracks` are *caches*, regenerable from the log at any time. They are only a
 * cache if they cannot disagree with it.
 */

interface CommitParams {
  trackId: number
  startedAt: number
  msListened: number
}

export class ListenStore {
  private readonly statements: {
    insert: Database.Statement<CommitParams>
    copyGenres: Database.Statement<{ listenId: number; trackId: number }>
    bumpTrack: Database.Statement<{ trackId: number; startedAt: number }>
  }

  private readonly commitTransaction: (params: CommitParams) => ListenCommit | null

  constructor(db: Database.Database) {
    this.statements = {
      // `INSERT ... SELECT FROM tracks` rather than an insert of values the
      // caller supplied: the snapshot is main's to resolve, and driving it off
      // the row makes the track's existence a `changes` of zero instead of a
      // foreign-key error thrown over a track that was audible a second ago.
      //
      // `OR IGNORE` for the identity index. A real collision needs two
      // transports committing in the same millisecond, which Fermata does not
      // have — but 014's note is explicit that the writer has to tolerate the
      // constraint, because "cannot happen" and "throws if it does" are
      // different promises.
      //
      // The `title IS NOT NULL` guard is 014's rule about attribution made into
      // a predicate. `listens.title` is `NOT NULL`, so an untagged track with
      // no title would otherwise be a thrown constraint at the end of a play;
      // as a predicate it is a listen that was not worth a row, which is what
      // the column means.
      //
      // `album_artist_name` has no `COALESCE`: `track_overrides` (D7) carries
      // title, artist, album, track no and disc no, and no album artist. It
      // resolves from the album, which is where it lives.
      insert: db.prepare(`
        INSERT OR IGNORE INTO listens
          (track_id, started_at, ms_listened, duration_ms,
           title, artist_name, album_title, album_artist_name)
        SELECT
          t.id,
          @startedAt,
          @msListened,
          t.duration_ms,
          COALESCE(o.title, t.title),
          COALESCE(o.artist_name, ar.name),
          COALESCE(o.album_title, al.title),
          aa.name
        FROM tracks t
        LEFT JOIN track_overrides o ON o.track_id = t.id
        LEFT JOIN artists ar ON ar.id = t.artist_id
        LEFT JOIN albums  al ON al.id = t.album_id
        LEFT JOIN artists aa ON aa.id = al.album_artist_id
        WHERE t.id = @trackId AND COALESCE(o.title, t.title) IS NOT NULL
      `),
      // Verbatim, both columns. `genre_key` groups and `genre` displays, and
      // copying only the key would make every rollup pick a spelling it has no
      // way to know. A track with no genres copies no rows and the listen still
      // commits — that is the ordinary state of a lot of libraries.
      copyGenres: db.prepare(`
        INSERT INTO listen_genres (listen_id, genre_key, genre)
        SELECT @listenId, genre_key, genre FROM track_genres WHERE track_id = @trackId
      `),
      // `MAX` rather than assignment, so `last_played_at` is exactly what a
      // rebuild from the log would compute — `MAX(started_at)` over the track's
      // listens. The quit-time flush is the case that needs it: a listen
      // departed at shutdown can land after one that started later, and a bare
      // assignment would move the cache backwards and make it disagree with the
      // table it is a cache of.
      bumpTrack: db.prepare(`
        UPDATE tracks
        SET play_count = play_count + 1,
            last_played_at = MAX(COALESCE(last_played_at, 0), @startedAt)
        WHERE id = @trackId
      `)
    }

    this.commitTransaction = db.transaction((params: CommitParams): ListenCommit | null => {
      const inserted = this.statements.insert.run(params)
      if (inserted.changes === 0) return null

      const id = Number(inserted.lastInsertRowid)
      this.statements.copyGenres.run({ listenId: id, trackId: params.trackId })
      this.statements.bumpTrack.run({ trackId: params.trackId, startedAt: params.startedAt })

      // W11-5's seam. The scrobble outbox row belongs *here*, inside this
      // transaction and after the log row it describes, so that a queued
      // submission can never name a listen the log does not hold. One row per
      // connected target, and only where `artist_name` resolved — the outbox
      // (012) makes it `NOT NULL` because every scrobbling target rejects a
      // submission missing it, which is the one place the two records are
      // written to diverge. `ScrobbleOutbox.enqueue` takes the entry; what does
      // not exist yet is the list of connected targets to enqueue against.

      return {
        id,
        trackId: params.trackId,
        startedAt: params.startedAt,
        msListened: params.msListened
      }
    })
  }

  /**
   * Writes one listen, or `null` when there was nothing to write.
   *
   * `null` has three causes and none is a fault: the track left the library
   * between departing and being committed, it has no title to be attributed to,
   * or `idx_listens_identity` already holds this `(started_at, title, artist)`.
   * In every one of them nothing at all happened — no genres, no play count.
   */
  commit(request: RecordListenRequest): ListenCommit | null {
    return this.commitTransaction({
      trackId: request.trackId,
      startedAt: request.startedAt,
      msListened: request.msListened
    })
  }
}
