import type Database from 'better-sqlite3'
import { ALBUM_MIN_TRACKS, SHELF_MIN_ITEMS } from '../constants'
import { dayKey, dayPick, tieBreak } from '../hash'
import { jsonIds, pickShelf, playedFractionWhy, toAlbumItem, unplayedWhy } from '../albums'
import type { Claimed, RecipeOutput } from '../types'

const HINT = 'A genre picked fresh for today.'

interface GenreAlbumRow {
  albumId: number
  title: string
  artist: string | null
  year: number | null
  artworkHash: string | null
  trackCount: number
  playedCount: number
  unplayedCount: number
}

/**
 * One genre per UTC day, chosen by hashing the day rather than by taste — the
 * exploration shelf (W12-6). Where *neglected-genre* is seed-scored and gated on
 * a non-empty seed, this one is not taste-gated and fires at cold start; the
 * only requirement is a genre with enough albums to fill a shelf.
 *
 * The pool is built over what earlier shelves *left* (it respects `claimed`), so
 * the day-pick can only land on a genre that will actually fill — that is what
 * lets it survive running last, after *unplayed* has taken the obvious leftovers.
 * The album pool folds file genres and the W15 user-tag layer on their shared
 * casefold key, exactly as *neglected-genre* does.
 */
export function genreRoulette(
  db: Database.Database,
  nowMs: number,
  claimed: Claimed
): RecipeOutput | null {
  const day = dayKey(nowMs)
  const pool = fillableGenreKeys(db, claimed)
  const pickedKey = dayPick('genre-roulette', pool, day)
  if (pickedKey === null) return null

  const rows = albumsInGenre(db, claimed, pickedKey)
  const ranked = rows
    .map((row) => ({ row, hash: tieBreak('genre-roulette', row.albumId, day) }))
    .sort((left, right) => left.hash - right.hash)

  // No taste score: within the day's genre, order is the day tie-break and every
  // card is equal quality, so `pickShelf` fills to the cap.
  const picked = pickShelf(ranked, () => 0)
  if (picked.length < SHELF_MIN_ITEMS) return null

  return {
    title: `Tonight's crate: ${genreDisplay(db, pickedKey)}`,
    hint: HINT,
    grain: 'album',
    items: picked.map(({ row }) =>
      toAlbumItem(
        row,
        row.unplayedCount === row.trackCount
          ? unplayedWhy(row.trackCount)
          : playedFractionWhy(row.playedCount, row.trackCount)
      )
    )
  }
}

/**
 * Genre keys (file genres ∪ user tags) with at least `SHELF_MIN_ITEMS` unclaimed
 * albums of `ALBUM_MIN_TRACKS`-plus tracks — the day-pick's candidate set.
 *
 * `qa` is the qualifying-album set (unclaimed, big enough), a few thousand rows
 * even at the 100k-track scale. Each `pair` arm walks the tag vocabulary and
 * keeps it to that set with `album_id IN (SELECT ... FROM qa)` — SQLite indexes
 * the small `qa` subquery rather than hash-joining a derived table against every
 * track, which is what keeps this off the O(rows × albums) cliff. `COUNT(DISTINCT
 * albumId)` folds the two arms together, so a file genre and a user tag sharing a
 * key — or an album with several tracks under one key — count that album once.
 * Keys only: the display spelling for the *one* picked key is a cheap point
 * lookup, not a group over the whole library.
 */
function fillableGenreKeys(db: Database.Database, claimed: Claimed): string[] {
  const rows = db
    .prepare(
      `WITH qa AS (
         SELECT album_id
           FROM tracks
          WHERE album_id IS NOT NULL
            AND album_id NOT IN (SELECT value FROM json_each(@claimedAlbums))
          GROUP BY album_id
         HAVING COUNT(*) >= @minTracks
       ),
       pair AS (
         SELECT tg.genre_key AS genreKey, t.album_id AS albumId
           FROM track_genres tg
           JOIN tracks t ON t.id = tg.track_id
          WHERE t.album_id IN (SELECT album_id FROM qa)
         UNION ALL
         SELECT gt.key AS genreKey, t.album_id AS albumId
           FROM track_tags tt
           JOIN tags gt ON gt.id = tt.tag_id
           JOIN tracks t ON t.id = tt.track_id
          WHERE t.album_id IN (SELECT album_id FROM qa)
       )
       SELECT genreKey
         FROM pair
        GROUP BY genreKey
       HAVING COUNT(DISTINCT albumId) >= @minAlbums`
    )
    .all({
      claimedAlbums: jsonIds(claimed.albumIds),
      minTracks: ALBUM_MIN_TRACKS,
      minAlbums: SHELF_MIN_ITEMS
    }) as { genreKey: string }[]
  return rows.map((row) => row.genreKey)
}

/**
 * Display spelling for one key: the file genre's canonical spelling if any file
 * carries it, else the user-tag label. Two indexed point lookups, run once for
 * the day's pick.
 */
function genreDisplay(db: Database.Database, genreKey: string): string {
  const row = db
    .prepare(
      `SELECT COALESCE(
                (SELECT genre FROM track_genres WHERE genre_key = @genreKey LIMIT 1),
                (SELECT label FROM tags WHERE key = @genreKey)
              ) AS display`
    )
    .get({ genreKey }) as { display: string | null }
  return row.display ?? genreKey
}

/**
 * Unclaimed `ALBUM_MIN_TRACKS`-plus albums carrying `genreKey` in either
 * vocabulary, with each album's play stats. No taste gate and no unplayed
 * requirement — exploration includes what you have dipped into.
 *
 * Driven *from the genre*, not from a full scan of `tracks`: `genre_albums` walks
 * only the genre's rows through `idx_track_genres_key` (and the small tag arm)
 * and folds to distinct album ids, then those albums' tracks are aggregated
 * through `idx_tracks_album`. That is the difference between touching the picked
 * genre's few thousand tracks and running a correlated `EXISTS` over every track
 * in the library — the shape *neglected-genre* can afford only because it is
 * gated to one taste-scored genre and often bails before it runs.
 */
function albumsInGenre(db: Database.Database, claimed: Claimed, genreKey: string): GenreAlbumRow[] {
  return db
    .prepare(
      `WITH genre_albums AS (
         SELECT t.album_id AS albumId
           FROM track_genres tg
           JOIN tracks t ON t.id = tg.track_id
          WHERE tg.genre_key = @genreKey
            AND t.album_id IS NOT NULL
            AND t.album_id NOT IN (SELECT value FROM json_each(@claimedAlbums))
         UNION
         SELECT t.album_id
           FROM track_tags tt
           JOIN tags gt ON gt.id = tt.tag_id
           JOIN tracks t ON t.id = tt.track_id
          WHERE gt.key = @genreKey
            AND t.album_id IS NOT NULL
            AND t.album_id NOT IN (SELECT value FROM json_each(@claimedAlbums))
       )
       SELECT al.id AS albumId,
              al.title AS title,
              aa.name AS artist,
              al.year AS year,
              al.artwork_hash AS artworkHash,
              COUNT(at.id) AS trackCount,
              SUM(CASE WHEN at.play_count > 0 THEN 1 ELSE 0 END) AS playedCount,
              SUM(CASE WHEN at.play_count = 0 THEN 1 ELSE 0 END) AS unplayedCount
       FROM genre_albums ga
       JOIN albums al ON al.id = ga.albumId
       LEFT JOIN artists aa ON aa.id = al.album_artist_id
       JOIN tracks at ON at.album_id = ga.albumId
       GROUP BY al.id
       HAVING COUNT(at.id) >= @minTracks`
    )
    .all({
      claimedAlbums: jsonIds(claimed.albumIds),
      genreKey,
      minTracks: ALBUM_MIN_TRACKS
    }) as GenreAlbumRow[]
}
