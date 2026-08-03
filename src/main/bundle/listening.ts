import type Database from 'better-sqlite3'
import type { RebuildCountersResult } from '@shared/stats'
import { rebuildTrackCounters } from '../stats/counters'

/**
 * The listening section of D11's export bundle: the `listens` log with its
 * genres, and `track_favorites`.
 *
 * `tables.ts` says *what* travels; this says *how*. It is a section rather than
 * the bundle because the container — the file, the manifest, the playlist and
 * rating sections, the IPC and the operator-facing import choices — is W6's and
 * does not exist yet. What exists here is the pair the amendment ruled on, in a
 * shape the exporter composes: a plain serialisable value out, and a merge in
 * that a future importer calls once per section.
 *
 * Electron-free, so the round trip is drivable under plain Node against two temp
 * databases — which is the only honest way to test a merge rule, since the claim
 * is about what happens when two libraries meet.
 *
 * ## Naming a track across machines
 *
 * Every reference out of this section is `(root label, rel_path)` and never an
 * id. Ids are machine-local, and D11's note on relative paths says why this is
 * the pair: the whole reason a path is stored relative to a *named* root is that
 * the other machine keeps its music somewhere else.
 *
 * A listen names a track anyway, but only as a courtesy. The row's meaning is in
 * its snapshot columns (014), so a listen whose reference resolves to nothing on
 * this machine still imports, still appears in every dashboard query, and simply
 * has a `NULL` `track_id` — which is exactly what 014's `ON DELETE SET NULL`
 * already means locally. A favorite is the opposite: it is *only* a reference,
 * so one that does not resolve has nothing left to import and is counted and
 * dropped.
 */

/** A track named the way a bundle can name it. Never an id. */
export interface BundleTrackRef {
  readonly rootLabel: string
  readonly relPath: string
}

export interface BundleListenGenre {
  /** Casefolded and trimmed: the grouping identity. */
  readonly key: string
  /** Display spelling as it was at listen time. */
  readonly genre: string
}

export interface BundleListen {
  readonly startedAt: number
  readonly msListened: number
  readonly durationMs: number | null
  readonly title: string
  readonly artistName: string | null
  readonly albumTitle: string | null
  readonly albumArtistName: string | null
  readonly genres: readonly BundleListenGenre[]
  /** `null` when the exporting machine had already lost the track (014's `SET NULL`). */
  readonly track: BundleTrackRef | null
}

export interface BundleFavorite {
  readonly track: BundleTrackRef
  readonly favoritedAt: number
}

export interface ListeningSection {
  readonly listens: readonly BundleListen[]
  readonly favorites: readonly BundleFavorite[]
}

export interface ImportListeningResult {
  /** Log rows this database did not already hold. */
  readonly listensInserted: number
  /** Log rows `idx_listens_identity` recognised. The idempotence of a second import. */
  readonly listensAlreadyHeld: number
  /** Of the inserted rows, those whose track reference resolved to nothing here. */
  readonly listensUnlinked: number
  /** Favorites written or refreshed. */
  readonly favoritesApplied: number
  /** Favorites naming a track this machine does not have. */
  readonly favoritesUnresolved: number
  /** What the rebuild over the merged log changed. Recomputed, never added. */
  readonly counters: RebuildCountersResult
}

/**
 * `ORDER BY started_at` rather than by id: the bundle's order is the chronology,
 * which is the one thing about the log that means the same on both machines.
 */
const SELECT_LISTENS = `
  SELECT l.id                AS id,
         l.started_at        AS startedAt,
         l.ms_listened       AS msListened,
         l.duration_ms       AS durationMs,
         l.title             AS title,
         l.artist_name       AS artistName,
         l.album_title       AS albumTitle,
         l.album_artist_name AS albumArtistName,
         r.label             AS rootLabel,
         t.rel_path          AS relPath
  FROM listens l
  LEFT JOIN tracks t ON t.id = l.track_id
  LEFT JOIN roots  r ON r.id = t.root_id
  ORDER BY l.started_at, l.id
`

const SELECT_LISTEN_GENRES = `
  SELECT listen_id AS listenId, genre_key AS genreKey, genre AS genre
  FROM listen_genres
  ORDER BY listen_id, genre_key
`

const SELECT_FAVORITES = `
  SELECT r.label       AS rootLabel,
         t.rel_path    AS relPath,
         f.favorited_at AS favoritedAt
  FROM track_favorites f
  JOIN tracks t ON t.id = f.track_id
  JOIN roots  r ON r.id = t.root_id
  ORDER BY f.favorited_at, f.track_id
`

interface ListenRow {
  id: number
  startedAt: number
  msListened: number
  durationMs: number | null
  title: string
  artistName: string | null
  albumTitle: string | null
  albumArtistName: string | null
  rootLabel: string | null
  relPath: string | null
}

interface GenreRow {
  listenId: number
  genreKey: string
  genre: string
}

interface FavoriteRow {
  rootLabel: string
  relPath: string
  favoritedAt: number
}

/**
 * Reads the whole log and the whole favorites table into a plain value.
 *
 * Whole, with no range and no cap, and that is the decision rather than the
 * default: a partial log would import as a complete one, because nothing in the
 * merge can tell the difference between "you did not listen then" and "the
 * bundle was cut off there". The counters recomputed on the other side would
 * then be confidently wrong. `listens` is the fastest-growing table in the
 * database, so a bundle from a heavy library is a large value in memory — which
 * is a cost the exporter that lands later may want to stream away, and never a
 * reason to narrow what the section means.
 *
 * Genres are read in one pass and grouped here rather than fetched per listen,
 * for the obvious reason.
 */
export function exportListening(db: Database.Database): ListeningSection {
  const genresByListen = new Map<number, BundleListenGenre[]>()
  for (const row of db.prepare(SELECT_LISTEN_GENRES).all() as GenreRow[]) {
    const existing = genresByListen.get(row.listenId)
    const genre = { key: row.genreKey, genre: row.genre }
    if (existing) existing.push(genre)
    else genresByListen.set(row.listenId, [genre])
  }

  const listens = (db.prepare(SELECT_LISTENS).all() as ListenRow[]).map((row) => ({
    startedAt: row.startedAt,
    msListened: row.msListened,
    durationMs: row.durationMs,
    title: row.title,
    artistName: row.artistName,
    albumTitle: row.albumTitle,
    albumArtistName: row.albumArtistName,
    genres: genresByListen.get(row.id) ?? [],
    // Both or neither: the join that produced them is the same one.
    track:
      row.rootLabel !== null && row.relPath !== null
        ? { rootLabel: row.rootLabel, relPath: row.relPath }
        : null
  }))

  const favorites = (db.prepare(SELECT_FAVORITES).all() as FavoriteRow[]).map((row) => ({
    track: { rootLabel: row.rootLabel, relPath: row.relPath },
    favoritedAt: row.favoritedAt
  }))

  return { listens, favorites }
}

/**
 * Resolves `(root label, rel_path)` against this machine's library.
 *
 * Two lookups, in this order, and the fallback is the part that matters. A
 * bundle from a machine that calls the same folder `Music` where this one calls
 * it `NAS` is precisely the differing layout D11's relative paths were chosen
 * for, and refusing to link it would make "portable across folder layouts" mean
 * nothing. So: the same-labelled root first, because a label match is the
 * operator agreeing that these are the same collection; then any root at all,
 * but **only when exactly one** track has that relative path. Two candidates is
 * not a near miss, it is a question this code cannot answer, and guessing would
 * attach someone's listening history to the wrong copy of a file.
 *
 * The rel_path fallback map is built once and lazily. `tracks` has no index on
 * `rel_path` alone — `UNIQUE(root_id, rel_path)` cannot serve a lookup without
 * the root — so the alternative is a full table scan per unresolved reference,
 * which at the 100k-track scale target is the import taking an afternoon.
 */
class TrackResolver {
  private readonly byRootAndPath: Database.Statement<{ rootId: number; relPath: string }>
  private readonly rootIdsByLabel = new Map<string, number>()
  private readonly memo = new Map<string, number | null>()
  private byRelPath: Map<string, number | null> | null = null

  constructor(private readonly db: Database.Database) {
    this.byRootAndPath = db.prepare(
      'SELECT id AS id FROM tracks WHERE root_id = @rootId AND rel_path = @relPath'
    )
    const roots = db.prepare('SELECT id AS id, label AS label FROM roots').all() as {
      id: number
      label: string
    }[]
    // Root labels are not unique in the schema. First one wins, deterministically
    // by id, rather than the resolution depending on row order.
    for (const root of [...roots].sort((a, b) => a.id - b.id)) {
      if (!this.rootIdsByLabel.has(root.label)) this.rootIdsByLabel.set(root.label, root.id)
    }
  }

  resolve(ref: BundleTrackRef): number | null {
    const key = `${ref.rootLabel} ${ref.relPath}`
    const memoized = this.memo.get(key)
    if (memoized !== undefined) return memoized
    const resolved = this.lookup(ref)
    this.memo.set(key, resolved)
    return resolved
  }

  private lookup(ref: BundleTrackRef): number | null {
    const rootId = this.rootIdsByLabel.get(ref.rootLabel)
    if (rootId !== undefined) {
      const row = this.byRootAndPath.get({ rootId, relPath: ref.relPath }) as
        { id: number } | undefined
      if (row) return row.id
    }
    return this.relPathIndex().get(ref.relPath) ?? null
  }

  private relPathIndex(): Map<string, number | null> {
    if (this.byRelPath) return this.byRelPath
    const index = new Map<string, number | null>()
    const rows = this.db
      .prepare('SELECT id AS id, rel_path AS relPath FROM tracks')
      .iterate() as Iterable<{ id: number; relPath: string }>
    for (const row of rows) {
      // `null` is the ambiguity marker: a second candidate makes the path
      // unusable rather than making the later row win.
      index.set(row.relPath, index.has(row.relPath) ? null : row.id)
    }
    this.byRelPath = index
    return index
  }
}

const INSERT_LISTEN = `
  INSERT OR IGNORE INTO listens
    (track_id, started_at, ms_listened, duration_ms,
     title, artist_name, album_title, album_artist_name)
  VALUES
    (@trackId, @startedAt, @msListened, @durationMs,
     @title, @artistName, @albumTitle, @albumArtistName)
`

/**
 * `OR IGNORE` on the child too. The parent either inserted or did not; if it
 * did, these are new rows, and the only way to collide is a payload carrying the
 * same `genre_key` twice for one listen — a malformed bundle, not a merge.
 */
const INSERT_LISTEN_GENRE = `
  INSERT OR IGNORE INTO listen_genres (listen_id, genre_key, genre) VALUES (?, ?, ?)
`

/**
 * Recency, expressed as `MAX` rather than as an assignment.
 *
 * "Resolves by recency" has to survive being applied twice and in either order,
 * or a re-import would walk the rail's ordering backwards. `MAX` is the same
 * choice `ListenStore` makes for `last_played_at` and for the same reason: a
 * merge rule that depends on which bundle arrived first is not a rule.
 */
const UPSERT_FAVORITE = `
  INSERT INTO track_favorites (track_id, favorited_at) VALUES (@trackId, @favoritedAt)
  ON CONFLICT(track_id) DO UPDATE
    SET favorited_at = MAX(excluded.favorited_at, track_favorites.favorited_at)
`

/**
 * Merges a bundle's listening section into this database.
 *
 * `INSERT OR IGNORE` against `idx_listens_identity` — `(started_at, title,
 * artist_name)` — so two machines' overlapping logs interleave without
 * duplicating, and importing the same bundle twice is importing it once. 014's
 * note on that index applies unchanged: SQLite does not collapse `NULL`s in a
 * `UNIQUE` index, so listens of untagged tracks dedupe on nothing and re-import
 * as duplicates. That was accepted when the index was designed, and this is the
 * caller who lives with it.
 *
 * **Recomputed, never added.** `rebuildTrackCounters` runs at the end, over the
 * merged log. Adding the bundle's `play_count` to this machine's would
 * double-count every listen the merge just recognised as shared.
 *
 * One transaction, the rebuild included. `rebuildTrackCounters` is documented as
 * wanting its own statement-level transaction and this widens the write lock
 * past that — deliberately, because a crash between the merge and the rebuild
 * would leave counters that disagree with the log, and the whole of D17 rests on
 * those columns being caches that cannot disagree with it.
 */
export function importListening(
  db: Database.Database,
  section: ListeningSection
): ImportListeningResult {
  const insertListen = db.prepare(INSERT_LISTEN)
  const insertGenre = db.prepare(INSERT_LISTEN_GENRE)
  const upsertFavorite = db.prepare(UPSERT_FAVORITE)

  const merge = db.transaction((): ImportListeningResult => {
    const resolver = new TrackResolver(db)
    let listensInserted = 0
    let listensAlreadyHeld = 0
    let listensUnlinked = 0

    for (const listen of section.listens) {
      const trackId = listen.track ? resolver.resolve(listen.track) : null
      const inserted = insertListen.run({
        trackId,
        startedAt: listen.startedAt,
        msListened: listen.msListened,
        durationMs: listen.durationMs,
        title: listen.title,
        artistName: listen.artistName,
        albumTitle: listen.albumTitle,
        albumArtistName: listen.albumArtistName
      })
      if (inserted.changes === 0) {
        listensAlreadyHeld += 1
        continue
      }
      listensInserted += 1
      if (trackId === null) listensUnlinked += 1
      const listenId = Number(inserted.lastInsertRowid)
      for (const genre of listen.genres) insertGenre.run(listenId, genre.key, genre.genre)
    }

    let favoritesApplied = 0
    let favoritesUnresolved = 0
    for (const favorite of section.favorites) {
      const trackId = resolver.resolve(favorite.track)
      if (trackId === null) {
        favoritesUnresolved += 1
        continue
      }
      upsertFavorite.run({ trackId, favoritedAt: favorite.favoritedAt })
      favoritesApplied += 1
    }

    return {
      listensInserted,
      listensAlreadyHeld,
      listensUnlinked,
      favoritesApplied,
      favoritesUnresolved,
      counters: rebuildTrackCounters(db)
    }
  })

  return merge()
}
