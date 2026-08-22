import type Database from 'better-sqlite3'
import { ALBUM_MIN_TRACKS } from '../constants'
import { jsonIds, pickShelf, toAlbumItem, unplayedWhy } from '../albums'
import type { TasteSeed } from '../seed'
import type { Claimed, RecipeOutput } from '../types'

const HINT = 'More from an artist you heart.'

interface ArtistPick {
  artistId: number
  name: string
  favoriteCount: number
  unplayedCount: number
}

interface ArtistAlbumRow {
  albumId: number
  title: string
  artist: string | null
  year: number | null
  artworkHash: string | null
  trackCount: number
}

/**
 * One artist not already claimed by *artists*, with a heart and an unplayed
 * remainder. FavoriteBias: only, applied to a discography tail.
 */
export function becauseFavorited(
  db: Database.Database,
  _nowMs: number,
  claimed: Claimed,
  _seed: TasteSeed
): RecipeOutput | null {
  const pick = pickArtist(db, claimed)
  if (pick === null) return null

  const rows = db
    .prepare(
      `SELECT al.id AS albumId,
              al.title AS title,
              aa.name AS artist,
              al.year AS year,
              al.artwork_hash AS artworkHash,
              stats.trackCount AS trackCount
       FROM (
         SELECT t.album_id AS albumId,
                COUNT(*) AS trackCount
         FROM tracks t
         JOIN albums al2 ON al2.id = t.album_id
         WHERE al2.album_artist_id = @artistId
           AND t.album_id NOT IN (SELECT value FROM json_each(@claimedAlbums))
         GROUP BY t.album_id
         HAVING COUNT(*) >= @minTracks
            AND SUM(CASE WHEN t.play_count = 0 THEN 1 ELSE 0 END) = COUNT(*)
       ) AS stats
       JOIN albums al ON al.id = stats.albumId
       LEFT JOIN artists aa ON aa.id = al.album_artist_id
       ORDER BY al.year IS NULL, al.year ASC, al.id ASC`
    )
    .all({
      artistId: pick.artistId,
      claimedAlbums: jsonIds(claimed.albumIds),
      minTracks: ALBUM_MIN_TRACKS
    }) as ArtistAlbumRow[]

  const ranked = rows.map((row) => ({ row, score: 1 }))
  const picked = pickShelf(ranked, (item) => item.score)
  if (picked.length === 0) return null

  return {
    title: `Because you favorited ${pick.name}`,
    hint: HINT,
    grain: 'album',
    items: picked.map(({ row }) => toAlbumItem(row, unplayedWhy(row.trackCount))),
    claimedArtistIds: [pick.artistId]
  }
}

function pickArtist(db: Database.Database, claimed: Claimed): ArtistPick | null {
  const candidate = db
    .prepare(
      `SELECT ar.id AS artistId,
              ar.name AS name,
              fav.favoriteCount AS favoriteCount,
              discog.unplayedCount AS unplayedCount
       FROM (
         SELECT t.artist_id AS artistId,
                COUNT(*) AS favoriteCount
         FROM track_favorites f
         JOIN tracks t ON t.id = f.track_id
         WHERE t.artist_id IS NOT NULL
         GROUP BY t.artist_id
       ) AS fav
       JOIN artists ar ON ar.id = fav.artistId
       JOIN (
         SELECT al.album_artist_id AS artistId,
                COUNT(*) AS unplayedCount
         FROM albums al
         JOIN (
           SELECT t.album_id AS albumId
           FROM tracks t
           WHERE t.album_id NOT IN (SELECT value FROM json_each(@claimedAlbums))
           GROUP BY t.album_id
           HAVING COUNT(*) >= @minTracks
              AND SUM(CASE WHEN t.play_count = 0 THEN 1 ELSE 0 END) = COUNT(*)
         ) AS unplayed ON unplayed.albumId = al.id
         WHERE al.album_artist_id IS NOT NULL
         GROUP BY al.album_artist_id
       ) AS discog ON discog.artistId = fav.artistId
       WHERE fav.artistId NOT IN (SELECT value FROM json_each(@claimedArtists))
       ORDER BY fav.favoriteCount DESC,
                discog.unplayedCount DESC,
                fav.artistId ASC
       LIMIT 1`
    )
    .get({
      claimedAlbums: jsonIds(claimed.albumIds),
      claimedArtists: jsonIds(claimed.artistIds),
      minTracks: ALBUM_MIN_TRACKS
    }) as ArtistPick | undefined

  return candidate ?? null
}
