import type Database from 'better-sqlite3'
import { ALBUM_MIN_TRACKS } from '../constants'
import { dayKey, tieBreak } from '../hash'
import { jsonIds, pickShelf, playedFractionWhy, toAlbumItem } from '../albums'
import type { TasteSeed } from '../seed'
import type { Claimed, RecipeOutput } from '../types'

const TITLE = 'Almost finished'
const HINT = 'You started these.'

interface HoleRow {
  albumId: number
  title: string
  artist: string | null
  year: number | null
  artworkHash: string | null
  trackCount: number
  playedCount: number
  lastPlayedAt: number | null
}

interface Ranked {
  row: HoleRow
  fraction: number
  hash: number
}

/**
 * Albums with a hole: some tracks played, some not. A streaming catalogue
 * cannot offer this honestly; the rest of the album is on disk.
 */
export function almostFinished(
  db: Database.Database,
  nowMs: number,
  claimed: Claimed,
  _seed: TasteSeed
): RecipeOutput | null {
  const day = dayKey(nowMs)
  const rows = db
    .prepare(
      `SELECT al.id AS albumId,
              al.title AS title,
              aa.name AS artist,
              al.year AS year,
              al.artwork_hash AS artworkHash,
              stats.trackCount AS trackCount,
              stats.playedCount AS playedCount,
              stats.lastPlayedAt AS lastPlayedAt
       FROM (
         SELECT t.album_id AS albumId,
                COUNT(*) AS trackCount,
                SUM(CASE WHEN t.play_count > 0 THEN 1 ELSE 0 END) AS playedCount,
                MAX(t.last_played_at) AS lastPlayedAt
         FROM tracks t
         WHERE t.album_id IS NOT NULL
           AND t.album_id NOT IN (SELECT value FROM json_each(@claimedAlbums))
         GROUP BY t.album_id
         HAVING COUNT(*) >= @minTracks
            AND SUM(CASE WHEN t.play_count > 0 THEN 1 ELSE 0 END) >= 1
            AND SUM(CASE WHEN t.play_count = 0 THEN 1 ELSE 0 END) >= 1
       ) AS stats
       JOIN albums al ON al.id = stats.albumId
       LEFT JOIN artists aa ON aa.id = al.album_artist_id`
    )
    .all({
      claimedAlbums: jsonIds(claimed.albumIds),
      minTracks: ALBUM_MIN_TRACKS
    }) as HoleRow[]

  const ranked: Ranked[] = rows.map((row) => ({
    row,
    fraction: row.playedCount / row.trackCount,
    hash: tieBreak('almost-finished', row.albumId, day)
  }))
  ranked.sort(
    (left, right) =>
      right.fraction - left.fraction ||
      (right.row.lastPlayedAt ?? 0) - (left.row.lastPlayedAt ?? 0) ||
      left.hash - right.hash
  )
  const picked = pickShelf(ranked, (item) => item.fraction)
  if (picked.length === 0) return null

  return {
    title: TITLE,
    hint: HINT,
    grain: 'album',
    items: picked.map(({ row }) =>
      toAlbumItem(row, playedFractionWhy(row.playedCount, row.trackCount))
    )
  }
}
