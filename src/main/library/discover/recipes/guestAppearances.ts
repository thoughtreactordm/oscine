import type Database from 'better-sqlite3'
import { ALBUM_MIN_TRACKS } from '../constants'
import { dayKey, tieBreak } from '../hash'
import { jsonIds, pickShelf, toAlbumItem } from '../albums'
import type { TasteSeed } from '../seed'
import type { Claimed, RecipeOutput } from '../types'

const TITLE = 'Guest appearances'
const HINT = 'Artists you play, on records filed under someone else.'

interface GuestRow {
  albumId: number
  title: string
  artist: string | null
  year: number | null
  artworkHash: string | null
  trackCount: number
  seedPerformerTracks: number
  seedArtistName: string
}

interface Ranked {
  row: GuestRow
  score: number
  hash: number
}

/**
 * Compilations and features: a seed performer on an album-artist who is not
 * in the seed. Dropped when there is no seed to appear from.
 */
export function guestAppearances(
  db: Database.Database,
  nowMs: number,
  claimed: Claimed,
  seed: TasteSeed
): RecipeOutput | null {
  if (seed.empty) return null

  const day = dayKey(nowMs)
  const rows = db
    .prepare(
      `SELECT al.id AS albumId,
              al.title AS title,
              aa.name AS artist,
              al.year AS year,
              al.artwork_hash AS artworkHash,
              stats.trackCount AS trackCount,
              stats.seedPerformerTracks AS seedPerformerTracks,
              (
                SELECT ar.name
                FROM tracks t
                JOIN artists ar ON ar.id = t.artist_id
                WHERE t.album_id = al.id
                  AND t.artist_id IN (SELECT value FROM json_each(@artistIds))
                GROUP BY t.artist_id
                ORDER BY COUNT(*) DESC, t.artist_id ASC
                LIMIT 1
              ) AS seedArtistName
       FROM (
         SELECT t.album_id AS albumId,
                COUNT(*) AS trackCount,
                SUM(CASE WHEN t.artist_id IN (SELECT value FROM json_each(@artistIds))
                         THEN 1 ELSE 0 END) AS seedPerformerTracks
         FROM tracks t
         JOIN albums al2 ON al2.id = t.album_id
         WHERE t.album_id IS NOT NULL
           AND t.album_id NOT IN (SELECT value FROM json_each(@claimedAlbums))
           AND (al2.album_artist_id IS NULL
                OR al2.album_artist_id NOT IN (SELECT value FROM json_each(@artistIds)))
         GROUP BY t.album_id
         HAVING COUNT(*) >= @minTracks
            AND SUM(CASE WHEN t.play_count = 0 THEN 1 ELSE 0 END) >= 1
            AND SUM(CASE WHEN t.artist_id IN (SELECT value FROM json_each(@artistIds))
                         THEN 1 ELSE 0 END) >= 1
       ) AS stats
       JOIN albums al ON al.id = stats.albumId
       LEFT JOIN artists aa ON aa.id = al.album_artist_id`
    )
    .all({
      artistIds: jsonIds(seed.artistIds),
      claimedAlbums: jsonIds(claimed.albumIds),
      minTracks: ALBUM_MIN_TRACKS
    }) as GuestRow[]

  const ranked: Ranked[] = rows.map((row) => ({
    row,
    score: row.seedPerformerTracks,
    hash: tieBreak('guest-appearances', row.albumId, day)
  }))
  ranked.sort((left, right) => right.score - left.score || left.hash - right.hash)
  const picked = pickShelf(ranked, (item) => item.score)
  if (picked.length === 0) return null

  return {
    title: TITLE,
    hint: HINT,
    grain: 'album',
    items: picked.map(({ row }) => toAlbumItem(row, `${row.seedArtistName} appears`))
  }
}
