import type Database from 'better-sqlite3'
import { ALBUM_MIN_TRACKS, NEGLECTED_LIBRARY_N, NEGLECTED_LISTEN_N } from '../constants'
import { dayKey, tieBreak } from '../hash'
import { jsonIds, pickShelf, playedFractionWhy, toAlbumItem, unplayedWhy } from '../albums'
import type { TasteSeed } from '../seed'
import type { Claimed, RecipeOutput } from '../types'

const HINT = 'A lot of the library, none of the listening.'

interface LibraryGenre {
  genreKey: string
  display: string
  trackCount: number
}

interface ListenCount {
  genreKey: string
  n: number
}

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

interface Ranked {
  row: GenreAlbumRow
  score: number
  hash: number
}

/**
 * One large library genre missing from recent listening. Dropped when every
 * large genre is also a listened genre — that shelf would be a lie — and on
 * an empty seed, which is a cold start rather than neglect.
 */
export function neglectedGenre(
  db: Database.Database,
  nowMs: number,
  claimed: Claimed,
  seed: TasteSeed
): RecipeOutput | null {
  if (seed.empty) return null

  const pick = pickGenre(db, nowMs, seed)
  if (pick === null) return null

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
              stats.unplayedCount AS unplayedCount
       FROM (
         SELECT t.album_id AS albumId,
                COUNT(*) AS trackCount,
                SUM(CASE WHEN t.play_count > 0 THEN 1 ELSE 0 END) AS playedCount,
                SUM(CASE WHEN t.play_count = 0 THEN 1 ELSE 0 END) AS unplayedCount
         FROM tracks t
         WHERE t.album_id IS NOT NULL
           AND t.album_id NOT IN (SELECT value FROM json_each(@claimedAlbums))
           AND (EXISTS (
                  SELECT 1
                  FROM tracks g
                  JOIN track_genres tg ON tg.track_id = g.id
                  WHERE g.album_id = t.album_id
                    AND tg.genre_key = @genreKey
                )
                OR EXISTS (
                  -- The user-tag layer, keyed by the same casefold (W15-6): an
                  -- album a user hand-tagged with the picked key is neglected in
                  -- exactly the sense this shelf means, whether or not any file
                  -- on it carries the genre. tags.key resolves through its UNIQUE
                  -- index and idx_track_tags_tag walks the assignments.
                  SELECT 1
                  FROM tracks g2
                  JOIN track_tags tt ON tt.track_id = g2.id
                  JOIN tags gtag ON gtag.id = tt.tag_id
                  WHERE g2.album_id = t.album_id
                    AND gtag.key = @genreKey
                ))
         GROUP BY t.album_id
         HAVING COUNT(*) >= @minTracks
            AND SUM(CASE WHEN t.play_count = 0 THEN 1 ELSE 0 END) >= 1
       ) AS stats
       JOIN albums al ON al.id = stats.albumId
       LEFT JOIN artists aa ON aa.id = al.album_artist_id`
    )
    .all({
      claimedAlbums: jsonIds(claimed.albumIds),
      genreKey: pick.genreKey,
      minTracks: ALBUM_MIN_TRACKS
    }) as GenreAlbumRow[]

  const ranked: Ranked[] = rows.map((row) => ({
    row,
    score: row.unplayedCount === row.trackCount ? 1 : 0,
    hash: tieBreak('neglected-genre', row.albumId, day)
  }))
  ranked.sort((left, right) => right.score - left.score || left.hash - right.hash)
  const picked = pickShelf(ranked, (item) => item.score)
  if (picked.length === 0) return null

  return {
    title: `${pick.display} you own and ignore`,
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

function pickGenre(
  db: Database.Database,
  nowMs: number,
  seed: TasteSeed
): { genreKey: string; display: string } | null {
  // The library-genre pool, widened to the user-tag layer (W15-6). File genres
  // and user tags fold to one bucket on their shared casefold key, so a key a
  // user only ever hand-applied is a first-class candidate here. `trackCount` is
  // `COUNT(DISTINCT track_id)` so a track carrying the key in both vocabularies
  // is one track, not two; the display prefers the file spelling and falls back
  // to the tag label for a key no file carries. Same read shape as the original
  // GROUP BY — the tag arm is user-scale and needs no new index.
  const library = db
    .prepare(
      `WITH keyed AS (
         SELECT genre_key AS key, genre AS label, track_id, 1 AS is_file
           FROM track_genres
         UNION ALL
         SELECT gt.key AS key, gt.label AS label, tt.track_id AS track_id, 0 AS is_file
           FROM track_tags tt
           JOIN tags gt ON gt.id = tt.tag_id
       )
       SELECT k.key AS genreKey,
              COALESCE(MAX(CASE WHEN k.is_file = 1 THEN k.label END), MAX(k.label)) AS display,
              COUNT(DISTINCT k.track_id) AS trackCount
       FROM keyed k
       GROUP BY k.key
       ORDER BY trackCount DESC, k.key ASC
       LIMIT @libraryN`
    )
    .all({ libraryN: NEGLECTED_LIBRARY_N }) as LibraryGenre[]

  const excluded = new Set(seed.genreKeys.slice(0, NEGLECTED_LISTEN_N))
  const candidates = library.filter((row) => !excluded.has(row.genreKey))
  if (candidates.length === 0) return null

  const fromMs = seed.windowMs === null ? 0 : nowMs - seed.windowMs
  const listens = db
    .prepare(
      `SELECT tg.genre_key AS genreKey,
              COUNT(*) AS n
       FROM listens l
       JOIN tracks t ON t.id = l.track_id
       JOIN track_genres tg ON tg.track_id = t.id
       WHERE l.started_at >= @fromMs
       GROUP BY tg.genre_key`
    )
    .all({ fromMs }) as ListenCount[]
  const listenCount = new Map(listens.map((row) => [row.genreKey, row.n]))

  let best: LibraryGenre | null = null
  let bestScore = -1
  for (const row of candidates) {
    const score = row.trackCount / (1 + (listenCount.get(row.genreKey) ?? 0))
    if (
      best === null ||
      score > bestScore ||
      (score === bestScore && row.genreKey < best.genreKey)
    ) {
      best = row
      bestScore = score
    }
  }
  return best === null ? null : { genreKey: best.genreKey, display: best.display }
}
