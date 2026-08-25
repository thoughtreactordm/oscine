import type Database from 'better-sqlite3'
import type { ListenCommit, RecordListenRequest } from '@shared/listens'
import type { ScrobblePayload, ScrobbleTarget } from '@shared/scrobble'
import { scrobbleEnqueueRejection, type ScrobbleOutbox } from '../scrobble/outbox'

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

/** The listen as it was just written — the row the queue entry is copied from. */
interface SnapshotRow {
  started_at: number
  duration_ms: number | null
  title: string
  artist_name: string | null
  album_title: string | null
  album_artist_name: string | null
}

/**
 * What the commit needs in order to also enqueue — **D19**, W11-5.
 *
 * Injected rather than imported, and optional, because the two are separable
 * facts: a build with no scrobbling, and every test of the log itself, wants a
 * store that writes listens and nothing else. Handing it in also keeps this
 * module Electron-free and the whole path drivable under plain Node.
 */
export interface ListenScrobbleSink {
  readonly outbox: ScrobbleOutbox
  /**
   * Asked per commit, never captured once.
   *
   * Connecting and disconnecting an account are ordinary gestures that happen
   * between one track and the next, and a list captured at construction would
   * keep enqueueing for an account the operator signed out of an hour ago —
   * the same reason `ScrobbleDrainWorkerOptions.targets` is a function.
   */
  targets(): readonly ScrobbleTarget[]
}

export interface ListenStoreOptions {
  /** Omitted means this build does not scrobble. Nothing else changes. */
  scrobble?: ListenScrobbleSink
}

export class ListenStore {
  private readonly statements: {
    insert: Database.Statement<CommitParams>
    copyGenres: Database.Statement<{ listenId: number; trackId: number }>
    bumpTrack: Database.Statement<{ trackId: number; startedAt: number }>
    snapshot: Database.Statement<{ id: number }>
  }

  private readonly commitTransaction: (params: CommitParams) => ListenCommit | null

  private readonly scrobble: ListenScrobbleSink | null

  constructor(db: Database.Database, options: ListenStoreOptions = {}) {
    this.scrobble = options.scrobble ?? null
    this.statements = {
      // `INSERT ... SELECT FROM tracks` rather than an insert of values the
      // caller supplied: the snapshot is main's to resolve, and driving it off
      // the row makes the track's existence a `changes` of zero instead of a
      // foreign-key error thrown over a track that was audible a second ago.
      //
      // `OR IGNORE` for the identity index. A real collision needs two
      // transports committing in the same millisecond, which Oscine does not
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
      `),
      // Read back rather than re-resolved from `tracks`. The queue row must say
      // exactly what the log row says, and the only way to guarantee that is for
      // both to come from the same row — re-running the joins would be a second
      // resolution of the same question, correct today and free to drift the
      // first time an override lands between the two statements.
      snapshot: db.prepare(`
        SELECT started_at, duration_ms, title, artist_name, album_title, album_artist_name
        FROM listens WHERE id = @id
      `)
    }

    this.commitTransaction = db.transaction((params: CommitParams): ListenCommit | null => {
      const inserted = this.statements.insert.run(params)
      if (inserted.changes === 0) return null

      const id = Number(inserted.lastInsertRowid)
      this.statements.copyGenres.run({ listenId: id, trackId: params.trackId })
      this.statements.bumpTrack.run({ trackId: params.trackId, startedAt: params.startedAt })

      // Inside this transaction and after the log row it describes, so that a
      // queued submission can never name a listen the log does not hold — and
      // so that a rollback takes both. A listen that recorded but did not
      // enqueue is a scrobble silently lost.
      this.enqueueScrobbles(id, params.trackId)

      return {
        id,
        trackId: params.trackId,
        startedAt: params.startedAt,
        msListened: params.msListened
      }
    })
  }

  /**
   * One `scrobble_queue` row per connected target, for the listen just written.
   *
   * ## Where the two records are allowed to disagree
   *
   * A listen with no artist name gets its `listens` row and no queue row. That
   * is the single written exception to Oscine's stats and the operator's
   * profile agreeing, and it exists because every scrobbling service rejects a
   * submission with no artist — so the alternatives are a queue row that can
   * never drain, or dropping a listen that Oscine's own charts have no problem
   * counting. Divergence by a stated rule beats divergence by an accident.
   *
   * ## Why the rejection is checked rather than caught
   *
   * `ScrobbleOutbox.enqueue` throws `UnsendableScrobbleError` for a payload it
   * will not take, and a throw from in here is inside `db.transaction` — it
   * would roll back the listen, its genres and its play count along with the
   * queue row. The listen is not the thing at fault, so the refusal is asked
   * for in advance instead of discovered by exception.
   */
  private enqueueScrobbles(listenId: number, trackId: number): void {
    if (this.scrobble === null) return

    const targets = this.scrobble.targets().filter((target) => target.connection().connected)
    // The overwhelmingly common case: nobody has ever signed in. It costs one
    // predicate and no query.
    if (targets.length === 0) return

    const row = this.statements.snapshot.get({ id: listenId }) as SnapshotRow | undefined
    if (row === undefined) return

    const payload: ScrobblePayload = {
      artistName: row.artist_name ?? '',
      title: row.title,
      albumTitle: row.album_title,
      albumArtistName: row.album_artist_name,
      // Both of these cross from Oscine's milliseconds into the wire's
      // seconds, and this is the only place either conversion happens. A
      // millisecond value accepted as seconds dates the scrobble to the year
      // 56000, which is the kind of wrong that reaches somebody's public
      // profile before it reaches a test.
      durationSeconds: row.duration_ms === null ? null : Math.round(row.duration_ms / 1000),
      timestamp: Math.floor(row.started_at / 1000)
    }

    for (const target of targets) {
      const entry = {
        target: target.id,
        kind: 'scrobble',
        listenId,
        trackId,
        payload
      } as const
      if (scrobbleEnqueueRejection(entry, target.capabilities) !== null) continue
      this.scrobble.outbox.enqueue(entry, target.capabilities)
    }
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
