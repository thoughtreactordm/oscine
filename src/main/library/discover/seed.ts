import type Database from 'better-sqlite3'
import { RECENT_FALLBACK_MS, RECENT_MS, SEED_MIN_ARTISTS } from './constants'

/**
 * The recent-listen taste seed.
 *
 * Distinct playable artists ranked by summed `ms_listened`, widening the
 * window from 30 days to 90 days to all-time until `SEED_MIN_ARTISTS` is met
 * or the log is exhausted. Genre keys are taken from `track_genres` unioned with
 * the user-tag layer (`track_tags`, W15-6) on the same playable listens, in the
 * window that the artist half settled on — live tags, not `listen_genres`
 * snapshots, so both a genre fix and a hand-applied tag improve Discover.
 *
 * Empty means cold start: *for-you* drops, *unplayed* is the page.
 */

export interface TasteSeed {
  /** Ranked most-listened first. */
  artistIds: readonly number[]
  artistMs: ReadonlyMap<number, number>
  genreKeys: readonly string[]
  genreMs: ReadonlyMap<string, number>
  /** The window that produced this seed, or `null` when the log was empty. */
  windowMs: number | null
  empty: boolean
}

const WINDOWS = [RECENT_MS, RECENT_FALLBACK_MS, null] as const

interface ArtistRow {
  artistId: number
  ms: number
}

interface GenreRow {
  genreKey: string
  ms: number
}

export function buildTasteSeed(db: Database.Database, nowMs: number): TasteSeed {
  let artists: ArtistRow[] = []
  let windowMs: number | null = null

  for (const window of WINDOWS) {
    const from = window === null ? 0 : nowMs - window
    artists = artistListenMs(db, from)
    windowMs = window
    if (artists.length >= SEED_MIN_ARTISTS) break
  }

  if (artists.length === 0) {
    return {
      artistIds: [],
      artistMs: new Map(),
      genreKeys: [],
      genreMs: new Map(),
      windowMs: null,
      empty: true
    }
  }

  const from = windowMs === null ? 0 : nowMs - windowMs
  const genres = genreListenMs(db, from)

  return {
    artistIds: artists.map((row) => row.artistId),
    artistMs: new Map(artists.map((row) => [row.artistId, row.ms])),
    genreKeys: genres.map((row) => row.genreKey),
    genreMs: new Map(genres.map((row) => [row.genreKey, row.ms])),
    windowMs,
    empty: false
  }
}

/**
 * Track performer, falling back to album artist. Listens whose `track_id` is
 * NULL — a file that left the library — do not seed; Discover is forward.
 */
function artistListenMs(db: Database.Database, fromMs: number): ArtistRow[] {
  return db
    .prepare(
      `SELECT COALESCE(t.artist_id, al.album_artist_id) AS artistId,
              SUM(l.ms_listened) AS ms
       FROM listens l
       JOIN tracks t ON t.id = l.track_id
       LEFT JOIN albums al ON al.id = t.album_id
       WHERE l.started_at >= @fromMs
       GROUP BY COALESCE(t.artist_id, al.album_artist_id)
       HAVING COALESCE(t.artist_id, al.album_artist_id) IS NOT NULL
       ORDER BY ms DESC, artistId ASC`
    )
    .all({ fromMs }) as ArtistRow[]
}

/**
 * Taste keys, widened to the user-tag layer (W15-6). A track's file genres and
 * its user tags fold to one bucket on the shared casefold key (`@shared/genre`),
 * so the inner `UNION` collapses `(track_id, key)` before the join — a track
 * carrying a key in both vocabularies weights that key by a listen's `ms` once,
 * not twice. The result is that hand-tagging what you play steers Discover the
 * same way a file genre does, live off `track_tags` rather than a snapshot.
 */
function genreListenMs(db: Database.Database, fromMs: number): GenreRow[] {
  return db
    .prepare(
      `SELECT k.key AS genreKey,
              SUM(l.ms_listened) AS ms
       FROM listens l
       JOIN tracks t ON t.id = l.track_id
       JOIN (
         SELECT track_id, genre_key AS key FROM track_genres
         UNION
         SELECT tt.track_id, gt.key AS key
           FROM track_tags tt
           JOIN tags gt ON gt.id = tt.tag_id
       ) k ON k.track_id = t.id
       WHERE l.started_at >= @fromMs
       GROUP BY k.key
       ORDER BY ms DESC, k.key ASC`
    )
    .all({ fromMs }) as GenreRow[]
}
