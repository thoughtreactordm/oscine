import type Database from 'better-sqlite3'
import type {
  FavoriteState,
  FavoriteStateResult,
  ListFavoriteIdsQuery,
  ListFavoriteIdsResult,
  ListFavoritesQuery,
  ListFavoritesResult,
  RemoveFavoritesResult
} from '@shared/favorites'
import { TRACK_JOINS, TRACK_PROJECTION, toTrack, type TrackRow } from '../library/store'

/**
 * `track_favorites`, and the five statements it is made of — **D18**.
 *
 * Its own module beside `../history/store` and `../listens/store`, following the
 * precedent `../library/playlists/store` set: one table the library layer never
 * writes. It *does* borrow `TRACK_PROJECTION`, where the listen commit
 * deliberately does not, and the difference is the same one the two delete rules
 * make. A listen is a snapshot of how a track read at a moment in the past; a
 * favorite is a statement about a track you can play *now*, so the rail must
 * show it exactly as the song list would, corrections included.
 *
 * Electron-free, so the whole thing is drivable under plain Node against a temp
 * file.
 */

export class FavoriteStore {
  private readonly statements: {
    insert: Database.Statement<{ trackId: number; favoritedAt: number }>
    remove: Database.Statement<[number]>
    state: Database.Statement<{ ids: string }>
    list: Database.Statement<{ limit: number; offset: number }>
    listIds: Database.Statement<{ limit: number; offset: number }>
    removeMany: Database.Statement<{ ids: string }>
    count: Database.Statement<[]>
  }

  private readonly toggleTransaction: (params: {
    trackId: number
    favoritedAt: number
  }) => FavoriteState

  constructor(db: Database.Database) {
    this.statements = {
      // `INSERT ... SELECT FROM tracks` rather than an insert of the id the
      // caller handed over, for the reason `ListenStore.insert` does it: the
      // track's absence becomes a `changes` of zero instead of a foreign-key
      // error thrown over a row whose heart the operator just clicked. A track
      // can leave the library between the render and the click, and that race is
      // ordinary rather than exceptional.
      //
      // `OR IGNORE` is belt and braces — the toggle deletes first, so the insert
      // only runs against a track that had no row a statement ago, and the
      // primary key means there is no second row to make. It costs nothing and
      // it is what stops a future caller that reaches past `toggle` from
      // throwing.
      insert: db.prepare(`
        INSERT OR IGNORE INTO track_favorites (track_id, favorited_at)
        SELECT t.id, @favoritedAt FROM tracks t WHERE t.id = @trackId
      `),
      remove: db.prepare('DELETE FROM track_favorites WHERE track_id = ?'),
      // One statement whatever the batch size. Taking the ids as a JSON array
      // rather than an IN-list of placeholders keeps this a single prepared
      // statement, exactly as `hydrateTracks` does and for the same reason: a
      // placeholder list re-compiles on every distinct length, and the lengths a
      // virtualized list produces are most of them.
      //
      // Driven from `json_each` into the primary key rather than the other way
      // round, so the work is one b-tree probe per requested id and never a scan
      // of the favorites table.
      state: db.prepare(`
        SELECT f.track_id AS trackId
        FROM json_each(@ids) requested
        JOIN track_favorites f ON f.track_id = requested.value
      `),
      // Newest-hearted first, `track_id` breaking ties. Two tracks hearted in the
      // same millisecond needs a keyboard repeat rather than a human, but an
      // unstable ORDER BY across a paged read is how a row appears on page two
      // having already been drawn on page one.
      list: db.prepare(`
        SELECT ${TRACK_PROJECTION}
        FROM track_favorites f
        JOIN tracks t ON t.id = f.track_id
        ${TRACK_JOINS}
        ORDER BY f.favorited_at DESC, f.track_id DESC
        LIMIT @limit OFFSET @offset
      `),
      // The same window and the same tie-break, read off the favorites table
      // alone. No join at all: a `JOIN tracks` here would exist only to prove
      // the row still resolves, and `CASCADE` already guarantees it does.
      listIds: db.prepare(`
        SELECT f.track_id AS trackId
        FROM track_favorites f
        ORDER BY f.favorited_at DESC, f.track_id DESC
        LIMIT @limit OFFSET @offset
      `),
      // One statement whatever the batch size, for `state`'s reason. Driven
      // into the primary key from `json_each`, so removing four hundred rows is
      // four hundred b-tree probes rather than a scan.
      removeMany: db.prepare(`
        DELETE FROM track_favorites
        WHERE track_id IN (SELECT value FROM json_each(@ids))
      `),
      count: db.prepare('SELECT count(*) AS total FROM track_favorites')
    }

    // Delete, and insert only if the delete found nothing. One transaction, so
    // the read that decides and the write that acts cannot be separated by
    // another connection — and so a caller can never observe the intermediate
    // state where the old row is gone and the new one is not yet there.
    this.toggleTransaction = db.transaction(
      (params: { trackId: number; favoritedAt: number }): FavoriteState => {
        if (this.statements.remove.run(params.trackId).changes > 0) {
          return { trackId: params.trackId, favorite: false, favoritedAt: null }
        }

        // Zero here means the track is not in the library — see `insert`. Not an
        // error: the honest answer to "is this favorited" for a track that does
        // not exist is no.
        if (this.statements.insert.run(params).changes === 0) {
          return { trackId: params.trackId, favorite: false, favoritedAt: null }
        }

        return { trackId: params.trackId, favorite: true, favoritedAt: params.favoritedAt }
      }
    )
  }

  /**
   * Flips one track's heart and reports what resulted.
   *
   * `favoritedAt` is stamped here rather than taken from the caller, the way
   * `history.record`'s timestamp is and unlike a listen's `started_at`. A
   * favorite happens at the click; there is no earlier moment for the renderer
   * to know about and so no argument for letting it claim one.
   */
  toggle(trackId: number): FavoriteState {
    return this.toggleTransaction({ trackId, favoritedAt: Date.now() })
  }

  /**
   * The favorited subset of a batch of ids.
   *
   * Deduped on the way in, as `orderTrackIds` does and for its reason: the
   * caller asked a question about a *set*, and the join is driven from the
   * request side, so an id sent twice would come back twice. Doing it here
   * rather than as a `SELECT DISTINCT` keeps the query a straight index probe
   * per id — `DISTINCT` would make SQLite sort a result that is already exactly
   * as large as it should be.
   */
  state(trackIds: readonly number[]): FavoriteStateResult {
    const unique = [...new Set(trackIds)]
    if (unique.length === 0) return { favoritedIds: [] }
    const rows = this.statements.state.all({ ids: JSON.stringify(unique) }) as {
      trackId: number
    }[]
    return { favoritedIds: rows.map((row) => row.trackId) }
  }

  /**
   * A page of favorites as display rows, newest first.
   *
   * The total comes from the favorites table alone rather than from the joined
   * query, which is the same shape `listTracks` uses: the count is what the
   * scrollbar is sized against, and it must not change because a row happened to
   * be off the end of this window.
   */
  list(query: ListFavoritesQuery): ListFavoritesResult {
    const { total } = this.statements.count.get() as { total: number }
    if (total === 0) return { tracks: [], total: 0 }

    const rows = this.statements.list.all({
      limit: query.limit,
      offset: query.offset
    }) as TrackRow[]
    return { tracks: rows.map(toTrack), total }
  }

  /**
   * The same page as `list`, as ids.
   *
   * Shares `list`'s two-part `ORDER BY` verbatim rather than approximating it,
   * because the two are read against each other: the pane resolves a Shift-range
   * through this and then draws those rows through that, and an ordering that
   * agreed only up to ties would select rows the operator did not point at.
   */
  listIds(query: ListFavoriteIdsQuery): ListFavoriteIdsResult {
    const { total } = this.statements.count.get() as { total: number }
    if (total === 0) return { ids: [], total: 0 }

    const rows = this.statements.listIds.all({
      limit: query.limit,
      offset: query.offset
    }) as { trackId: number }[]
    return { ids: rows.map((row) => row.trackId), total }
  }

  /**
   * Un-favorites a batch.
   *
   * Ids that were not favorited — or are not tracks at all — are simply not
   * deleted, which is why the result is a count rather than a per-id answer. A
   * removal is idempotent by nature: asking twice and getting `4` then `0` is
   * the honest report of what happened, not a failure to be raised.
   */
  removeMany(trackIds: readonly number[]): RemoveFavoritesResult {
    const unique = [...new Set(trackIds)]
    if (unique.length === 0) return { removed: 0 }
    const { changes } = this.statements.removeMany.run({ ids: JSON.stringify(unique) })
    return { removed: changes }
  }
}
