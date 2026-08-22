import type Database from 'better-sqlite3'
import { REVISIT_AGE_MS } from '../constants'
import { heartedWhy, jsonIds, pickShelf, toTrackItem } from '../albums'
import type { TasteSeed } from '../seed'
import type { Claimed, RecipeOutput } from '../types'

const TITLE = 'Forgotten favorites'
const HINT = 'You hearted these.'

interface FavoriteRow {
  trackId: number
  title: string
  artist: string | null
  albumTitle: string | null
  artworkHash: string | null
  lastPlayedAt: number | null
  favoritedAt: number
}

/**
 * Hearted tracks that have never been played, or not for a long time. Empty
 * favorites is a normal state; omitting the shelf is the empty state.
 */
export function forgottenFavorites(
  db: Database.Database,
  nowMs: number,
  claimed: Claimed,
  _seed: TasteSeed
): RecipeOutput | null {
  const rows = db
    .prepare(
      `SELECT t.id AS trackId,
              t.title AS title,
              ar.name AS artist,
              al.title AS albumTitle,
              al.artwork_hash AS artworkHash,
              t.last_played_at AS lastPlayedAt,
              f.favorited_at AS favoritedAt
       FROM track_favorites f
       JOIN tracks t ON t.id = f.track_id
       LEFT JOIN artists ar ON ar.id = t.artist_id
       LEFT JOIN albums al ON al.id = t.album_id
       WHERE t.id NOT IN (SELECT value FROM json_each(@claimedTracks))
         AND (t.play_count = 0 OR t.last_played_at < @ageCutoff)
       ORDER BY t.last_played_at IS NOT NULL,
                t.last_played_at ASC,
                f.favorited_at ASC,
                t.id ASC`
    )
    .all({
      claimedTracks: jsonIds(claimed.trackIds),
      ageCutoff: nowMs - REVISIT_AGE_MS
    }) as FavoriteRow[]

  const ranked = rows.map((row) => ({ row, score: 1 }))
  const picked = pickShelf(ranked, (item) => item.score)
  if (picked.length === 0) return null

  return {
    title: TITLE,
    hint: HINT,
    grain: 'track',
    items: picked.map(({ row }) => toTrackItem(row, heartedWhy(nowMs, row.lastPlayedAt)))
  }
}
