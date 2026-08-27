import type Database from 'better-sqlite3'
import { ALBUM_MIN_TRACKS, HEAVY_MS } from '../constants'
import { dayKey, tieBreak } from '../hash'
import {
  jsonIds,
  jsonKeys,
  pickShelf,
  playedFractionWhy,
  toAlbumItem,
  unplayedWhy
} from '../albums'
import type { TasteSeed } from '../seed'
import type { Claimed, RecipeOutput } from '../types'

const TITLE = 'Built for you'
const HINT = 'From what you have been playing.'

interface ForYouRow {
  albumId: number
  title: string
  artist: string | null
  year: number | null
  artworkHash: string | null
  albumArtistId: number | null
  trackCount: number
  unplayedCount: number
  playedCount: number
  lastPlayedAt: number | null
  hasFavorite: number
  seedAlbumArtist: number
  seedMajority: number
  seedGenre: number
}

interface Ranked {
  row: ForYouRow
  score: number
  hash: number
}

/**
 * Unplayed and underplayed albums from the taste seed, excluding whatever is
 * in heavy rotation. Empty seed → drop, which is the honest cold start.
 */
export function forYou(
  db: Database.Database,
  nowMs: number,
  claimed: Claimed,
  seed: TasteSeed
): RecipeOutput | null {
  if (seed.empty) return null

  const day = dayKey(nowMs)
  const rows = db
    .prepare(
      `SELECT *
       FROM (
         SELECT al.id AS albumId,
                al.title AS title,
                aa.name AS artist,
                al.year AS year,
                al.artwork_hash AS artworkHash,
                al.album_artist_id AS albumArtistId,
                stats.trackCount AS trackCount,
                stats.unplayedCount AS unplayedCount,
                stats.playedCount AS playedCount,
                stats.lastPlayedAt AS lastPlayedAt,
                stats.hasFavorite AS hasFavorite,
                CASE WHEN al.album_artist_id IN (SELECT value FROM json_each(@artistIds))
                     THEN 1 ELSE 0 END AS seedAlbumArtist,
                CASE WHEN stats.seedPerformerTracks * 2 > stats.trackCount
                     THEN 1 ELSE 0 END AS seedMajority,
                CASE WHEN EXISTS (
                  SELECT 1
                  FROM tracks g
                  JOIN track_genres tg ON tg.track_id = g.id
                  WHERE g.album_id = al.id
                    AND tg.genre_key IN (SELECT value FROM json_each(@genreKeys))
                ) OR EXISTS (
                  -- The user-tag layer, keyed by the same casefold (W15-6): the
                  -- seed already carries the tags of what you play, so an album
                  -- sharing one is as much a taste match as a shared file genre.
                  SELECT 1
                  FROM tracks g2
                  JOIN track_tags tt ON tt.track_id = g2.id
                  JOIN tags gtag ON gtag.id = tt.tag_id
                  WHERE g2.album_id = al.id
                    AND gtag.key IN (SELECT value FROM json_each(@genreKeys))
                ) THEN 1 ELSE 0 END AS seedGenre
         FROM (
           SELECT t.album_id AS albumId,
                  COUNT(*) AS trackCount,
                  SUM(CASE WHEN t.play_count = 0 THEN 1 ELSE 0 END) AS unplayedCount,
                  SUM(CASE WHEN t.play_count > 0 THEN 1 ELSE 0 END) AS playedCount,
                  MAX(t.last_played_at) AS lastPlayedAt,
                  MAX(CASE WHEN f.track_id IS NOT NULL THEN 1 ELSE 0 END) AS hasFavorite,
                  SUM(CASE WHEN t.artist_id IN (SELECT value FROM json_each(@artistIds))
                           THEN 1 ELSE 0 END) AS seedPerformerTracks
           FROM tracks t
           LEFT JOIN track_favorites f ON f.track_id = t.id
           WHERE t.album_id IS NOT NULL
             AND t.album_id NOT IN (SELECT value FROM json_each(@claimedAlbums))
           GROUP BY t.album_id
           HAVING COUNT(*) >= @minTracks
         ) AS stats
         JOIN albums al ON al.id = stats.albumId
         LEFT JOIN artists aa ON aa.id = al.album_artist_id
         WHERE stats.lastPlayedAt IS NULL OR stats.lastPlayedAt < @heavyCutoff
       )
       WHERE seedAlbumArtist = 1 OR seedMajority = 1 OR seedGenre = 1`
    )
    .all({
      artistIds: jsonIds(seed.artistIds),
      genreKeys: jsonKeys(seed.genreKeys),
      claimedAlbums: jsonIds(claimed.albumIds),
      minTracks: ALBUM_MIN_TRACKS,
      heavyCutoff: nowMs - HEAVY_MS
    }) as ForYouRow[]

  const ranked: Ranked[] = []
  for (const row of rows) {
    const seedArtist = row.seedAlbumArtist === 1 || row.seedMajority === 1
    const unplayed = row.unplayedCount === row.trackCount
    const underplayed = row.unplayedCount > 0 && !unplayed
    let tier: number
    if (unplayed && seedArtist) tier = 3
    else if (underplayed && seedArtist) tier = 2
    else if (unplayed && row.seedGenre === 1) tier = 1
    else if (underplayed && row.seedGenre === 1) tier = 0
    else continue
    ranked.push({
      row,
      score: tier * 10 + (row.hasFavorite === 1 ? 1 : 0),
      hash: tieBreak('for-you', row.albumId, day)
    })
  }

  ranked.sort((left, right) => right.score - left.score || left.hash - right.hash)
  const picked = pickShelf(ranked, (item) => item.score)
  if (picked.length === 0) return null

  return {
    title: TITLE,
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
