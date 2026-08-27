import type Database from 'better-sqlite3'
import { ALBUM_MIN_TRACKS } from '../constants'
import { dayKey, tieBreak } from '../hash'
import { jsonIds, jsonKeys, pickShelf, spread, toAlbumItem, unplayedWhy } from '../albums'
import type { TasteSeed } from '../seed'
import type { Claimed, RecipeOutput } from '../types'

const TITLE = 'Sitting unplayed'
const HINT = 'In your library, never heard.'

interface UnplayedRow {
  albumId: number
  title: string
  artist: string | null
  year: number | null
  artworkHash: string | null
  albumArtistId: number | null
  genreKey: string | null
  trackCount: number
  seedArtist: number
  seedGenre: number
}

interface Ranked {
  row: UnplayedRow
  score: number
  hash: number
}

/**
 * Complete albums nobody has listened to. A sample, not a dump: seed artists,
 * then seed genres, then everyone else, with artist then genre diversity so
 * the first discography in the table cannot fill the strip. Cold start may be
 * thinner than `SHELF_MIN_ITEMS`; compose is the one that keeps it.
 */
export function unplayed(
  db: Database.Database,
  nowMs: number,
  claimed: Claimed,
  seed: TasteSeed
): RecipeOutput | null {
  const day = dayKey(nowMs)
  const rows = db
    .prepare(
      `SELECT al.id AS albumId,
              al.title AS title,
              aa.name AS artist,
              al.year AS year,
              al.artwork_hash AS artworkHash,
              al.album_artist_id AS albumArtistId,
              -- A single key for the diversity spread below. File genre first,
              -- falling back to a user tag so a tag-only album still spreads by
              -- its key rather than clumping under NULL (W15-6).
              COALESCE(
                (
                  SELECT tg.genre_key
                  FROM tracks g
                  JOIN track_genres tg ON tg.track_id = g.id
                  WHERE g.album_id = al.id
                  ORDER BY tg.genre_key
                  LIMIT 1
                ),
                (
                  SELECT gtag.key
                  FROM tracks g2
                  JOIN track_tags tt ON tt.track_id = g2.id
                  JOIN tags gtag ON gtag.id = tt.tag_id
                  WHERE g2.album_id = al.id
                  ORDER BY gtag.key
                  LIMIT 1
                )
              ) AS genreKey,
              stats.trackCount AS trackCount,
              CASE WHEN al.album_artist_id IN (SELECT value FROM json_each(@artistIds))
                   THEN 1 ELSE 0 END AS seedArtist,
              CASE WHEN EXISTS (
                SELECT 1
                FROM tracks g
                JOIN track_genres tg ON tg.track_id = g.id
                WHERE g.album_id = al.id
                  AND tg.genre_key IN (SELECT value FROM json_each(@genreKeys))
              ) OR EXISTS (
                -- The user-tag layer, same casefold key set (W15-6).
                SELECT 1
                FROM tracks g2
                JOIN track_tags tt ON tt.track_id = g2.id
                JOIN tags gtag ON gtag.id = tt.tag_id
                WHERE g2.album_id = al.id
                  AND gtag.key IN (SELECT value FROM json_each(@genreKeys))
              ) THEN 1 ELSE 0 END AS seedGenre
       FROM (
         SELECT t.album_id AS albumId,
                COUNT(*) AS trackCount
         FROM tracks t
         WHERE t.album_id IS NOT NULL
           AND t.album_id NOT IN (SELECT value FROM json_each(@claimedAlbums))
         GROUP BY t.album_id
         HAVING COUNT(*) >= @minTracks
            AND SUM(CASE WHEN t.play_count = 0 THEN 1 ELSE 0 END) = COUNT(*)
       ) AS stats
       JOIN albums al ON al.id = stats.albumId
       LEFT JOIN artists aa ON aa.id = al.album_artist_id`
    )
    .all({
      artistIds: jsonIds(seed.artistIds),
      genreKeys: jsonKeys(seed.genreKeys),
      claimedAlbums: jsonIds(claimed.albumIds),
      minTracks: ALBUM_MIN_TRACKS
    }) as UnplayedRow[]

  const ranked: Ranked[] = rows.map((row) => ({
    row,
    score: row.seedArtist * 2 + row.seedGenre,
    hash: tieBreak('unplayed', row.albumId, day)
  }))
  ranked.sort((left, right) => right.score - left.score || left.hash - right.hash)

  const diversified = spread(
    spread(ranked, (item) => item.row.albumArtistId),
    (item) => item.row.genreKey
  )
  const picked = pickShelf(diversified, (item) => item.score)
  if (picked.length === 0) return null

  return {
    title: TITLE,
    hint: HINT,
    grain: 'album',
    items: picked.map(({ row }) => toAlbumItem(row, unplayedWhy(row.trackCount)))
  }
}
