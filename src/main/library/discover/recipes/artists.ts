import type Database from 'better-sqlite3'
import { ALBUM_MIN_TRACKS, DEEP_MIN_ALBUMS, DEEP_TOP_N } from '../constants'
import { jsonIds, pickShelf, toAlbumItem, unplayedWhy } from '../albums'
import type { TasteSeed } from '../seed'
import type { Claimed, RecipeOutput } from '../types'

const HINT = 'Where the tail of a discography is.'

interface ArtistPick {
  artistId: number
  name: string
  listenMs: number
  albumCount: number
  unplayedCount: number
}

interface ArtistAlbumRow {
  albumId: number
  title: string
  artist: string | null
  year: number | null
  artworkHash: string | null
  trackCount: number
  mixed: number
}

/**
 * One album-artist from the deep-catalog tail, and that artist's unplayed
 * albums in year order. Local discography only — not MusicBrainz, not "complete
 * this artist" against a remote list. Dropped rather than falling back to a
 * generic heading over random albums.
 */
export function artists(
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
              stats.trackCount AS trackCount,
              stats.mixed AS mixed
       FROM (
         SELECT t.album_id AS albumId,
                COUNT(*) AS trackCount,
                SUM(CASE WHEN t.play_count = 0 THEN 1 ELSE 0 END) AS unplayedCount,
                MAX(CASE WHEN t.artist_id IS NOT NULL
                          AND t.artist_id IS NOT @artistId
                         THEN 1 ELSE 0 END) AS mixed
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
       ORDER BY stats.mixed ASC,
                al.year IS NULL, al.year ASC,
                al.id ASC`
    )
    .all({
      artistId: pick.artistId,
      claimedAlbums: jsonIds(claimed.albumIds),
      minTracks: ALBUM_MIN_TRACKS
    }) as ArtistAlbumRow[]

  // Equal quality — they are all unplayed from the same discography — so
  // pickShelf fills to the cap rather than stopping at the target.
  const ranked = rows.map((row) => ({ row, score: 1 }))
  const picked = pickShelf(ranked, (item) => item.score)
  if (picked.length === 0) return null

  return {
    title: `Deeper into ${pick.name}`,
    hint: HINT,
    grain: 'album',
    items: picked.map(({ row }) => toAlbumItem(row, unplayedWhy(row.trackCount))),
    claimedArtistIds: [pick.artistId]
  }
}

function pickArtist(db: Database.Database, claimed: Claimed): ArtistPick | null {
  const candidates = db
    .prepare(
      `SELECT ranked.artistId AS artistId,
              ar.name AS name,
              ranked.listenMs AS listenMs,
              discog.albumCount AS albumCount,
              discog.unplayedCount AS unplayedCount
       FROM (
         SELECT COALESCE(t.artist_id, al.album_artist_id) AS artistId,
                SUM(l.ms_listened) AS listenMs
         FROM listens l
         JOIN tracks t ON t.id = l.track_id
         LEFT JOIN albums al ON al.id = t.album_id
         GROUP BY COALESCE(t.artist_id, al.album_artist_id)
         HAVING COALESCE(t.artist_id, al.album_artist_id) IS NOT NULL
         ORDER BY listenMs DESC, artistId ASC
         LIMIT @topN
       ) AS ranked
       JOIN artists ar ON ar.id = ranked.artistId
       JOIN (
         SELECT al.album_artist_id AS artistId,
                COUNT(*) AS albumCount,
                SUM(CASE WHEN unplayed.albumId IS NOT NULL THEN 1 ELSE 0 END) AS unplayedCount
         FROM albums al
         JOIN (
           SELECT t.album_id AS albumId
           FROM tracks t
           GROUP BY t.album_id
           HAVING COUNT(*) >= @minTracks
         ) AS sized ON sized.albumId = al.id
         LEFT JOIN (
           SELECT t.album_id AS albumId
           FROM tracks t
           GROUP BY t.album_id
           HAVING COUNT(*) >= @minTracks
              AND SUM(CASE WHEN t.play_count = 0 THEN 1 ELSE 0 END) = COUNT(*)
         ) AS unplayed ON unplayed.albumId = al.id
         WHERE al.album_artist_id IS NOT NULL
         GROUP BY al.album_artist_id
         HAVING COUNT(*) >= @minAlbums
       ) AS discog ON discog.artistId = ranked.artistId
       WHERE ranked.artistId NOT IN (SELECT value FROM json_each(@claimedArtists))
       ORDER BY (ranked.listenMs * (CAST(discog.unplayedCount AS REAL) / discog.albumCount)) DESC,
                ranked.listenMs DESC,
                ranked.artistId ASC
       LIMIT 1`
    )
    .get({
      topN: DEEP_TOP_N,
      minTracks: ALBUM_MIN_TRACKS,
      minAlbums: DEEP_MIN_ALBUMS,
      claimedArtists: jsonIds(claimed.artistIds)
    }) as ArtistPick | undefined

  return candidates ?? null
}
