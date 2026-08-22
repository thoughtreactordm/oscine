import type Database from 'better-sqlite3'
import { ALBUM_MIN_TRACKS, REVISIT_AGE_MS, REVISIT_PLAY_MAX } from '../constants'
import { dayKey, tieBreak } from '../hash'
import { jsonIds, lastPlayedWhy, pickShelf, toAlbumItem } from '../albums'
import type { TasteSeed } from '../seed'
import type { Claimed, RecipeOutput } from '../types'

const TITLE = 'Worth revisiting'
const HINT = 'Played once, a long time ago.'

interface RevisitRow {
  albumId: number
  title: string
  artist: string | null
  year: number | null
  artworkHash: string | null
  trackCount: number
  playedCount: number
  lastPlayedAt: number
}

interface Ranked {
  row: RevisitRow
  score: number
  hash: number
}

/**
 * Albums finished, or nearly, a long time ago. "Played" is a D17 listen —
 * `play_history` is out. Dropped when the library's listening is younger than
 * `REVISIT_AGE_MS`, because nothing in it can be forgotten yet.
 */
export function revisit(
  db: Database.Database,
  nowMs: number,
  claimed: Claimed,
  _seed: TasteSeed
): RecipeOutput | null {
  if (!listeningIsOldEnough(db, nowMs)) return null

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
                MAX(t.last_played_at) AS lastPlayedAt,
                MIN(t.play_count) AS minPlays,
                MAX(t.play_count) AS maxPlays
         FROM tracks t
         WHERE t.album_id IS NOT NULL
           AND t.album_id NOT IN (SELECT value FROM json_each(@claimedAlbums))
         GROUP BY t.album_id
         HAVING COUNT(*) >= @minTracks
            AND MIN(t.play_count) >= 1
            AND MAX(t.play_count) <= @playMax
            AND MAX(t.last_played_at) IS NOT NULL
            AND MAX(t.last_played_at) < @ageCutoff
       ) AS stats
       JOIN albums al ON al.id = stats.albumId
       LEFT JOIN artists aa ON aa.id = al.album_artist_id`
    )
    .all({
      claimedAlbums: jsonIds(claimed.albumIds),
      minTracks: ALBUM_MIN_TRACKS,
      playMax: REVISIT_PLAY_MAX,
      ageCutoff: nowMs - REVISIT_AGE_MS
    }) as RevisitRow[]

  const ranked: Ranked[] = rows.map((row) => ({
    row,
    score: Math.round((row.playedCount / row.trackCount) * 1000),
    hash: tieBreak('revisit', row.albumId, day)
  }))
  ranked.sort((left, right) => right.score - left.score || left.hash - right.hash)
  const picked = pickShelf(ranked, (item) => item.score)
  if (picked.length === 0) return null

  return {
    title: TITLE,
    hint: HINT,
    grain: 'album',
    items: picked.map(({ row }) => toAlbumItem(row, lastPlayedWhy(nowMs, row.lastPlayedAt)))
  }
}

function listeningIsOldEnough(db: Database.Database, nowMs: number): boolean {
  const row = db.prepare('SELECT MIN(started_at) AS first FROM listens').get() as {
    first: number | null
  }
  return row.first !== null && row.first <= nowMs - REVISIT_AGE_MS
}
