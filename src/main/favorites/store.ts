import type Database from 'better-sqlite3'
import {
  ARTIST_FAVORITES_LIMIT,
  type ArtistFavoriteStateResult,
  type ArtistFavoritesQuery,
  type ArtistFavoritesResult,
  type FavoriteArtist,
  type FavoriteState,
  type FavoriteStateResult,
  type ListFavoriteArtistsResult,
  type ListFavoriteIdsQuery,
  type ListFavoriteIdsResult,
  type ListFavoritePlaylistsResult,
  type ListFavoritesQuery,
  type ListFavoritesResult,
  type PlaylistFavoriteStateResult,
  type RemoveFavoritesResult
} from '@shared/favorites'
import type { ScrobblePayload, ScrobbleTarget } from '@shared/scrobble'
import { scrobbleEnqueueRejection, type ScrobbleOutbox } from '../scrobble/outbox'
import { PLAYLIST_PROJECTION, toPlaylist, type PlaylistRow } from '../library/playlists/store'
import { TRACK_JOINS, TRACK_PROJECTION, toTrack, type TrackRow } from '../library/store'

/**
 * `track_favorites`, and the statements it is made of — **D18**.
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
 *
 * ## The loved push — **W11-6**, one-way and forward-only
 *
 * A heart also enqueues a `love` row and an un-heart an `unlove` row, through
 * the same outbox as scrobbles so that both inherit persistence, ordering and
 * backoff instead of growing a second retry path.
 *
 * **Forward-only is a property of where the enqueue lives**, not of a flag. It
 * happens here, inside the gesture — so there is no code path that walks
 * `track_favorites` and pushes what is already in it. Connecting an account
 * cannot push a library's worth of hearts to somebody else's profile on the
 * strength of one click, because nothing anywhere is written that could.
 *
 * The other way in is D11's bundle, which merges `track_favorites` with its own
 * SQL rather than through this class — so importing a second machine's thousand
 * hearts enqueues nothing, which is right for the same reason connecting does
 * not. Worth knowing before anyone routes that merge through `toggle` for the
 * tidiness of it: doing so would turn an import into a bulk push, silently.
 *
 * **One-way is a property of what is absent.** Nothing in this module, or
 * anywhere under `../scrobble/`, reads a loved-tracks list back. `track_favorites`
 * is authoritative and local (D18); a two-way sync would need a conflict rule for
 * "loved there, un-hearted here" and there is no right one.
 */

/**
 * What the toggle needs in order to also enqueue — W11-6.
 *
 * Injected and optional for `ListenScrobbleSink`'s reasons: a build with no
 * scrobbling, and every test of favorites themselves, wants a store that writes
 * one table and nothing else. It also keeps this module Electron-free.
 */
export interface FavoriteScrobbleSink {
  readonly outbox: ScrobbleOutbox
  /** Asked per gesture, never captured — accounts come and go between clicks. */
  targets(): readonly ScrobbleTarget[]
  /**
   * The `lastfm.loveOnFavorite` gate, read per gesture for the same reason.
   *
   * One predicate rather than one per target, because there is exactly one
   * loving target and the setting is named for it. A second service that loves
   * would want a key each, and the honest place to discover that is W11-8 —
   * which is also the card that would be adding the second key.
   */
  lovePushEnabled(): boolean
}

export interface FavoriteStoreOptions {
  /** Omitted means this build does not scrobble. Nothing else changes. */
  scrobble?: FavoriteScrobbleSink
}

/** A track as a love identifies it: artist and title, resolved through D7. */
interface LoveSnapshot {
  trackId: number
  title: string | null
  artistName: string | null
}

export class FavoriteStore {
  private readonly statements: {
    insert: Database.Statement<{ trackId: number; favoritedAt: number }>
    remove: Database.Statement<[number]>
    state: Database.Statement<{ ids: string }>
    list: Database.Statement<{ limit: number; offset: number }>
    listIds: Database.Statement<{ limit: number; offset: number }>
    seedArtist: Database.Statement<[number]>
    byArtist: Database.Statement<{ artistId: number; limit: number }>
    removeMany: Database.Statement<{ ids: string }>
    count: Database.Statement<[]>
    loveSnapshot: Database.Statement<[number]>
    loveSnapshots: Database.Statement<{ ids: string }>
    // D24 — playlists and artists, on their own tables. No love push: the star
    // is local-only, so these are plain writes, never an outbox row.
    togglePlaylistInsert: Database.Statement<{ playlistId: number; favoritedAt: number }>
    togglePlaylistRemove: Database.Statement<[number]>
    playlistState: Database.Statement<{ ids: string }>
    listPlaylists: Database.Statement<{ limit: number }>
    toggleArtistInsert: Database.Statement<{ artistId: number; favoritedAt: number }>
    toggleArtistRemove: Database.Statement<[number]>
    artistState: Database.Statement<{ ids: string }>
    listArtists: Database.Statement<{ limit: number }>
  }

  private readonly toggleTransaction: (params: {
    trackId: number
    favoritedAt: number
  }) => FavoriteState

  private readonly removeTransaction: (params: { ids: string; at: number }) => RemoveFavoritesResult

  private readonly togglePlaylistTransaction: (params: {
    playlistId: number
    favoritedAt: number
  }) => PlaylistFavoriteStateResult

  private readonly toggleArtistTransaction: (params: {
    artistId: number
    favoritedAt: number
  }) => ArtistFavoriteStateResult

  private readonly scrobble: FavoriteScrobbleSink | null

  constructor(db: Database.Database, options: FavoriteStoreOptions = {}) {
    this.scrobble = options.scrobble ?? null
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
      // Who the deck's Artist tab is about, read straight off the seed row.
      //
      // A statement of its own rather than a join inside the one below, because
      // the two answers it separates are two different sentences in the pane: a
      // `null` here is "this track names no artist" and an empty result there is
      // "this artist has no favorites yet". One query returning no rows cannot
      // tell them apart, and the second of those is the invitation the card is
      // mostly about.
      //
      // `artist_id` and not the album artist. The performer on the playing track
      // is what the tab is titled with — `ArtistIdentityStore.forTrack` joins
      // this same column — so keying on anything else would list the favorites of
      // somebody other than the artist named at the top of the tab. A track on a
      // compilation is exactly where the two differ, and exactly where getting it
      // wrong is most visible.
      seedArtist: db.prepare('SELECT artist_id AS artistId FROM tracks WHERE id = ?'),
      // That artist's favorites: `list`'s query with a `WHERE` on it and no
      // `OFFSET`, sharing the same two-part `ORDER BY` for the reason the two
      // above share it. The pane and the rail are two readings of one table, and
      // an order that agreed only up to ties would show the same two tracks in
      // two sequences.
      //
      // No `total` and no count statement of its own. The pane is a bounded
      // answer rather than a window — `ARTIST_FAVORITES_LIMIT + 1` rows come
      // back and the extra one becomes `truncated` — so there is no scrollbar to
      // size and therefore no second query to size it with.
      byArtist: db.prepare(`
        SELECT ${TRACK_PROJECTION}
        FROM track_favorites f
        JOIN tracks t ON t.id = f.track_id
        ${TRACK_JOINS}
        WHERE t.artist_id = @artistId
        ORDER BY f.favorited_at DESC, f.track_id DESC
        LIMIT @limit
      `),
      // One statement whatever the batch size, for `state`'s reason. Driven
      // into the primary key from `json_each`, so removing four hundred rows is
      // four hundred b-tree probes rather than a scan.
      removeMany: db.prepare(`
        DELETE FROM track_favorites
        WHERE track_id IN (SELECT value FROM json_each(@ids))
      `),
      count: db.prepare('SELECT count(*) AS total FROM track_favorites'),
      // What a love says, resolved exactly as the rail draws it — through
      // `track_overrides` (D7). A correction the operator made is the name they
      // believe the song has, and it is the one that should reach Last.fm; the
      // listen commit resolves the same two columns the same way, so a scrobble
      // and a love for one track can never name it differently.
      //
      // No album and no duration: `track.love` has no parameter for either (see
      // `loveParams`), so snapshotting them would be storing fields onto the
      // queue row that nothing will ever read.
      loveSnapshot: db.prepare(`
        SELECT
          t.id AS trackId,
          COALESCE(o.title, t.title) AS title,
          COALESCE(o.artist_name, ar.name) AS artistName
        FROM tracks t
        LEFT JOIN track_overrides o ON o.track_id = t.id
        LEFT JOIN artists ar ON ar.id = t.artist_id
        WHERE t.id = ?
      `),
      // The batch form, for `removeMany`. Driven from `json_each` into the
      // primary key as `state` and `removeMany` are, and joined through
      // `track_favorites` so it returns exactly the rows the delete is about to
      // take — an id that is not favorited enqueues no unlove, because nothing
      // was un-hearted.
      loveSnapshots: db.prepare(`
        SELECT
          t.id AS trackId,
          COALESCE(o.title, t.title) AS title,
          COALESCE(o.artist_name, ar.name) AS artistName
        FROM json_each(@ids) requested
        JOIN track_favorites f ON f.track_id = requested.value
        JOIN tracks t ON t.id = f.track_id
        LEFT JOIN track_overrides o ON o.track_id = t.id
        LEFT JOIN artists ar ON ar.id = t.artist_id
      `),

      // D24 — the playlist and artist stars. Each mirrors the track heart's two
      // gestures (toggle, batch state) and adds a short capped list, but neither
      // enqueues a thing: a star is a local fact and there is no remote loved-
      // playlists list to push it to.
      //
      // The insert is `INSERT ... SELECT FROM playlists` for `insert`'s reason —
      // a playlist that left between render and click becomes a `changes` of zero
      // rather than a foreign-key throw — and `OR IGNORE` is the same belt to its
      // braces, since the toggle deletes before it inserts.
      togglePlaylistInsert: db.prepare(`
        INSERT OR IGNORE INTO playlist_favorites (playlist_id, favorited_at)
        SELECT p.id, @favoritedAt FROM playlists p WHERE p.id = @playlistId
      `),
      togglePlaylistRemove: db.prepare('DELETE FROM playlist_favorites WHERE playlist_id = ?'),
      // One statement whatever the batch size, driven from `json_each` into the
      // primary key — `state`'s shape exactly, one table over.
      playlistState: db.prepare(`
        SELECT f.playlist_id AS id
        FROM json_each(@ids) requested
        JOIN playlist_favorites f ON f.playlist_id = requested.value
      `),
      // The Quick Menu's Favorite Playlists list: the shared playlist projection
      // with a `WHERE` supplied by the join, newest-starred first and `playlist_id`
      // breaking ties for `list`'s reason. Capped by the caller, never paged (D26).
      listPlaylists: db.prepare(`
        SELECT ${PLAYLIST_PROJECTION}
        FROM playlist_favorites f
        JOIN playlists p ON p.id = f.playlist_id
        ORDER BY f.favorited_at DESC, f.playlist_id DESC
        LIMIT @limit
      `),
      toggleArtistInsert: db.prepare(`
        INSERT OR IGNORE INTO artist_favorites (artist_id, favorited_at)
        SELECT a.id, @favoritedAt FROM artists a WHERE a.id = @artistId
      `),
      toggleArtistRemove: db.prepare('DELETE FROM artist_favorites WHERE artist_id = ?'),
      artistState: db.prepare(`
        SELECT f.artist_id AS id
        FROM json_each(@ids) requested
        JOIN artist_favorites f ON f.artist_id = requested.value
      `),
      // Favorite Artists, and the one place this surface reaches past its own
      // table. `artists` carries no artwork of its own (D14's resolved artist
      // photo lives in the renderer's cache, not here), so the thumbnail is
      // borrowed from the artist's own discography: the newest album they are the
      // album-artist of that actually has cover art. `null` for the many artists
      // that have none, which is the field's documented empty value rather than a
      // failure. The subquery is correlated and bounded — one probe per listed
      // artist, and the list itself is capped short.
      listArtists: db.prepare(`
        SELECT
          a.id AS id,
          a.name AS name,
          (
            SELECT al.artwork_hash
            FROM albums al
            WHERE al.album_artist_id = a.id AND al.artwork_hash IS NOT NULL
            ORDER BY al.year IS NULL, al.year DESC, al.id ASC
            LIMIT 1
          ) AS artworkHash
        FROM artist_favorites f
        JOIN artists a ON a.id = f.artist_id
        ORDER BY f.favorited_at DESC, f.artist_id DESC
        LIMIT @limit
      `)
    }

    // Delete, and insert only if the delete found nothing. One transaction, so
    // the read that decides and the write that acts cannot be separated by
    // another connection — and so a caller can never observe the intermediate
    // state where the old row is gone and the new one is not yet there.
    this.toggleTransaction = db.transaction(
      (params: { trackId: number; favoritedAt: number }): FavoriteState => {
        if (this.statements.remove.run(params.trackId).changes > 0) {
          this.enqueueLoves('unlove', this.snapshotOne(params.trackId), params.favoritedAt)
          return { trackId: params.trackId, favorite: false, favoritedAt: null }
        }

        // Zero here means the track is not in the library — see `insert`. Not an
        // error: the honest answer to "is this favorited" for a track that does
        // not exist is no.
        if (this.statements.insert.run(params).changes === 0) {
          return { trackId: params.trackId, favorite: false, favoritedAt: null }
        }

        // Inside this transaction and after the write it describes, exactly as
        // the listen commit enqueues inside its own: a rollback must take the
        // heart and its push together, and a heart that recorded without
        // enqueueing is a love silently lost.
        this.enqueueLoves('love', this.snapshotOne(params.trackId), params.favoritedAt)

        return { trackId: params.trackId, favorite: true, favoritedAt: params.favoritedAt }
      }
    )

    // Read, then delete, then enqueue — one transaction, because the read is
    // what decides which unloves to send. Outside one, a second connection could
    // remove a row between the two statements and the queue would carry an
    // unlove for a heart this call did not withdraw.
    this.removeTransaction = db.transaction(
      (params: { ids: string; at: number }): RemoveFavoritesResult => {
        const snapshots = this.statements.loveSnapshots.all(params) as LoveSnapshot[]
        const { changes } = this.statements.removeMany.run({ ids: params.ids })
        this.enqueueLoves('unlove', snapshots, params.at)
        return { removed: changes }
      }
    )

    // Delete, and insert only if the delete found nothing — the track toggle's
    // transaction without the love push, because the star has none. A `favoritedIds`
    // of `[id]` means it is now starred, `[]` means it is not: the same
    // `EntityFavoriteStateResult` the batch state returns, so the caller reads the
    // outcome off the row that flipped rather than predicting its own click. A
    // zero from the insert is a playlist not in the library, and the honest answer
    // for a thing that does not exist is that it is not favorited.
    this.togglePlaylistTransaction = db.transaction(
      (params: { playlistId: number; favoritedAt: number }): PlaylistFavoriteStateResult => {
        if (this.statements.togglePlaylistRemove.run(params.playlistId).changes > 0) {
          return { favoritedIds: [] }
        }
        if (this.statements.togglePlaylistInsert.run(params).changes === 0) {
          return { favoritedIds: [] }
        }
        return { favoritedIds: [params.playlistId] }
      }
    )

    this.toggleArtistTransaction = db.transaction(
      (params: { artistId: number; favoritedAt: number }): ArtistFavoriteStateResult => {
        if (this.statements.toggleArtistRemove.run(params.artistId).changes > 0) {
          return { favoritedIds: [] }
        }
        if (this.statements.toggleArtistInsert.run(params).changes === 0) {
          return { favoritedIds: [] }
        }
        return { favoritedIds: [params.artistId] }
      }
    )
  }

  /** One track's love snapshot, or none when it is not in the library. */
  private snapshotOne(trackId: number): LoveSnapshot[] {
    const row = this.statements.loveSnapshot.get(trackId) as LoveSnapshot | undefined
    return row === undefined ? [] : [row]
  }

  /**
   * One `scrobble_queue` row per snapshot per loving target — W11-6.
   *
   * ## Three ways this enqueues nothing, and all of them are ordinary
   *
   * The setting is off; no account is connected; or the connected target has no
   * loves to record (`supportsLove`, which is what ListenBrainz will answer in
   * W11-8). The last one matters more than it looks: a love row queued for a
   * target that can never send it is a row that can never drain, so the check
   * belongs here, before the write, rather than in the worker that would
   * discover it.
   *
   * The commonest case by far is nobody having ever signed in, and it costs one
   * predicate and no query.
   *
   * ## Why the refusal is asked for rather than caught
   *
   * `ScrobbleOutbox.enqueue` throws for a payload it will not take, and a throw
   * from in here is inside `db.transaction` — it would roll back the heart along
   * with the queue row. An untagged track is not a reason to refuse somebody's
   * favorite: the heart is a local fact and stands whether or not any service
   * can be told about it, so the rejection is checked in advance and the row is
   * simply not enqueued. It is the same divergence rule the listen commit
   * states, for the same reason.
   */
  private enqueueLoves(
    kind: 'love' | 'unlove',
    snapshots: readonly LoveSnapshot[],
    at: number
  ): void {
    if (this.scrobble === null || snapshots.length === 0) return
    if (!this.scrobble.lovePushEnabled()) return

    const targets = this.scrobble
      .targets()
      .filter((target) => target.connection().connected && target.capabilities.supportsLove)
    if (targets.length === 0) return

    // Seconds, like every other `timestamp` in the queue. Never transmitted —
    // `track.love` has no timestamp parameter — but it is what `ready` orders
    // by, and ordering is the whole of what makes heart, un-heart, heart again
    // settle loved rather than un-loved. Two flips inside one second share a
    // value and `id ASC` separates them, which is why the outbox orders by both.
    const timestamp = Math.floor(at / 1000)

    for (const snapshot of snapshots) {
      const payload: ScrobblePayload = {
        artistName: snapshot.artistName ?? '',
        title: snapshot.title ?? '',
        albumTitle: null,
        albumArtistName: null,
        durationSeconds: null,
        timestamp
      }

      for (const target of targets) {
        const entry = {
          target: target.id,
          kind,
          listenId: null,
          trackId: snapshot.trackId,
          payload
        } as const
        if (scrobbleEnqueueRejection(entry, target.capabilities) !== null) continue
        this.scrobble.outbox.enqueue(entry, target.capabilities)
      }
    }
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
   * The seed track's artist's favorites, newest-hearted first.
   *
   * Two indexed reads: the seed's `artist_id` off the primary key, then that
   * artist's hearted tracks. The second is skipped entirely when the first says
   * `null`, so a track with no artist tag costs one probe and no scan.
   *
   * Over-fetches by one and trims, exactly as `buildRelated`'s strands do: a
   * `LIMIT n` that returns `n` rows cannot tell "that is all there is" from
   * "there is more", and the pane would round a cap up into a fact. The extra
   * row is never sent.
   *
   * An artist with no favorites comes back with an empty list and not an error.
   * That is the ordinary case over a large library — it is the pane's empty
   * state rather than its failure state, which is why this returns a result at
   * all instead of `null` the way `buildRelated` does for a missing seed. A
   * `trackId` that is not in the library takes the same path as a track with no
   * artist, and should: neither has an artist whose favorites could be listed.
   */
  byArtist(query: ArtistFavoritesQuery, limit = ARTIST_FAVORITES_LIMIT): ArtistFavoritesResult {
    const empty = { seedTrackId: query.trackId, artistId: null, tracks: [], truncated: false }

    const seed = this.statements.seedArtist.get(query.trackId) as
      { artistId: number | null } | undefined
    const artistId = seed?.artistId ?? null
    if (artistId === null) return empty

    const rows = this.statements.byArtist.all({ artistId, limit: limit + 1 }) as TrackRow[]

    return {
      seedTrackId: query.trackId,
      artistId,
      tracks: rows.slice(0, limit).map(toTrack),
      truncated: rows.length > limit
    }
  }

  /**
   * Un-favorites a batch.
   *
   * Ids that were not favorited — or are not tracks at all — are simply not
   * deleted, which is why the result is a count rather than a per-id answer. A
   * removal is idempotent by nature: asking twice and getting `4` then `0` is
   * the honest report of what happened, not a failure to be raised.
   *
   * The unloves it enqueues follow the same rule: one per heart actually
   * withdrawn, so the second call sends nothing (W11-6).
   */
  removeMany(trackIds: readonly number[]): RemoveFavoritesResult {
    const unique = [...new Set(trackIds)]
    if (unique.length === 0) return { removed: 0 }
    return this.removeTransaction({ ids: JSON.stringify(unique), at: Date.now() })
  }

  /**
   * Flips one playlist's star — **D24**.
   *
   * `favorited_at` is stamped here, like the track heart's and for its reason: a
   * star happens at the click and there is no earlier moment the renderer could
   * claim.
   */
  togglePlaylist(playlistId: number): PlaylistFavoriteStateResult {
    return this.togglePlaylistTransaction({ playlistId, favoritedAt: Date.now() })
  }

  /** The starred subset of a batch of playlist ids. Deduped, `state`'s shape. */
  playlistState(playlistIds: readonly number[]): PlaylistFavoriteStateResult {
    const unique = [...new Set(playlistIds)]
    if (unique.length === 0) return { favoritedIds: [] }
    const rows = this.statements.playlistState.all({ ids: JSON.stringify(unique) }) as {
      id: number
    }[]
    return { favoritedIds: rows.map((row) => row.id) }
  }

  /** The Quick Menu's Favorite Playlists, newest-starred first, capped by `limit`. */
  listPlaylists(limit: number): ListFavoritePlaylistsResult {
    const rows = this.statements.listPlaylists.all({ limit }) as PlaylistRow[]
    return { playlists: rows.map(toPlaylist) }
  }

  /** Flips one artist's star — **D24**. `togglePlaylist`'s twin. */
  toggleArtist(artistId: number): ArtistFavoriteStateResult {
    return this.toggleArtistTransaction({ artistId, favoritedAt: Date.now() })
  }

  /** The starred subset of a batch of artist ids. */
  artistState(artistIds: readonly number[]): ArtistFavoriteStateResult {
    const unique = [...new Set(artistIds)]
    if (unique.length === 0) return { favoritedIds: [] }
    const rows = this.statements.artistState.all({ ids: JSON.stringify(unique) }) as {
      id: number
    }[]
    return { favoritedIds: rows.map((row) => row.id) }
  }

  /**
   * The Quick Menu's Favorite Artists, newest-starred first, capped by `limit`.
   *
   * `artworkHash` is borrowed from the artist's discography — see the statement —
   * and comes back already the `FavoriteArtist` shape, so there is nothing to map.
   */
  listArtists(limit: number): ListFavoriteArtistsResult {
    const rows = this.statements.listArtists.all({ limit }) as FavoriteArtist[]
    return { artists: rows }
  }
}
